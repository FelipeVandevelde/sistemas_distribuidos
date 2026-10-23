using System.Buffers.Binary;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

public sealed class DockerEngineClient : IDisposable
{
    private const string CompileMarker = "__DOCKERCODE_COMPILE_ERROR__";
    private const int OutputLimit = 64 * 1024;

    private readonly HttpClient _client;
    private readonly ILogger<DockerEngineClient> _logger;
    private readonly IConfiguration _configuration;

    private static readonly IReadOnlyDictionary<string, SandboxSpec> Specs =
        new Dictionary<string, SandboxSpec>(StringComparer.OrdinalIgnoreCase)
        {
            ["python"] = new(
                "dockercode-sandbox-python:latest",
                "main.py",
                "python /workspace/main.py < /workspace/stdin.txt"),
            ["javascript"] = new(
                "dockercode-sandbox-javascript:latest",
                "main.js",
                "node /workspace/main.js < /workspace/stdin.txt"),
            ["java"] = new(
                "dockercode-sandbox-java:latest",
                "Main.java",
                $"cd /workspace; javac Main.java || {{ code=$?; echo '{CompileMarker}' >&2; exit $code; }}; java Main < stdin.txt"),
            ["cpp"] = new(
                "dockercode-sandbox-cpp:latest",
                "main.cpp",
                $"cd /workspace; g++ main.cpp -O2 -o main || {{ code=$?; echo '{CompileMarker}' >&2; exit $code; }}; ./main < stdin.txt")
        };

    public DockerEngineClient(IConfiguration configuration, ILogger<DockerEngineClient> logger)
    {
        _configuration = configuration;
        _logger = logger;
        var socketPath = configuration["Docker:SocketPath"] ?? "/var/run/docker.sock";

        var handler = new SocketsHttpHandler
        {
            ConnectCallback = async (_, cancellationToken) =>
            {
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                try
                {
                    await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath), cancellationToken);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            }
        };

        _client = new HttpClient(handler)
        {
            BaseAddress = new Uri("http://docker"),
            Timeout = Timeout.InfiniteTimeSpan
        };
    }

    public async Task EnsureSandboxImagesAsync(CancellationToken cancellationToken)
    {
        foreach (var spec in Specs.Values)
        {
            if (!await ImageExistsAsync(spec.Image, cancellationToken))
                throw new InvalidOperationException($"Imagem de sandbox ausente: {spec.Image}. Execute o sandbox-builder pelo Docker Compose.");
        }
    }

    public async Task<SandboxExecutionResult> ExecuteAsync(
        Guid jobId,
        string language,
        string sourceCode,
        string stdin,
        CancellationToken cancellationToken)
    {
        if (!Specs.TryGetValue(language, out var spec))
            return new SandboxExecutionResult("FAILED", "", "Linguagem não suportada pelo Worker.", null, "INVALID_LANGUAGE");

        var timeoutSeconds = _configuration.GetValue("Sandbox:TimeoutSeconds", 10);
        var memoryMb = _configuration.GetValue("Sandbox:MemoryMb", 128);
        var nanoCpus = _configuration.GetValue<long>("Sandbox:NanoCpus", 500_000_000);
        var pidsLimit = _configuration.GetValue<long>("Sandbox:PidsLimit", 64);
        var containerName = $"dockercode-{jobId:N}-{Guid.NewGuid().ToString("N")[..6]}";
        var volumeName = containerName;
        string? containerId = null;
        var volumeCreated = false;
        var timedOut = false;

        try
        {
            await CreateWorkspaceVolumeAsync(volumeName, cancellationToken);
            volumeCreated = true;

            var waitCommand = $"while [ ! -f /workspace/.ready ]; do sleep 0.05; done; {spec.Command}";
            containerId = await CreateContainerAsync(
                containerName,
                spec.Image,
                waitCommand,
                volumeName,
                memoryMb,
                nanoCpus,
                pidsLimit,
                cancellationToken);

            await StartContainerAsync(containerId, cancellationToken);

            var archive = TarArchiveHelper.Create(new Dictionary<string, byte[]>
            {
                [spec.SourceFileName] = Encoding.UTF8.GetBytes(sourceCode),
                ["stdin.txt"] = Encoding.UTF8.GetBytes(stdin ?? string.Empty),
                [".ready"] = []
            });
            await PutArchiveAsync(containerId, archive, cancellationToken);

            int? exitCode;
            using (var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
            {
                timeoutCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
                try
                {
                    exitCode = await WaitContainerAsync(containerId, timeoutCts.Token);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    timedOut = true;
                    await KillContainerAsync(containerId, CancellationToken.None);
                    exitCode = null;
                }
            }

            var (stdout, stderr) = await GetLogsAsync(containerId, cancellationToken);
            var inspection = await InspectContainerAsync(containerId, cancellationToken);

            stdout = Truncate(stdout, OutputLimit);
            stderr = Truncate(stderr, OutputLimit);

            if (timedOut)
                return new SandboxExecutionResult("TIMEOUT", stdout, stderr, exitCode, "TIMEOUT");

            if (inspection.OomKilled || exitCode == 137 || IsRuntimeOutOfMemory(stderr))
                return new SandboxExecutionResult("FAILED", stdout, stderr, exitCode, "MEMORY_LIMIT");

            if (exitCode == 0)
                return new SandboxExecutionResult("SUCCEEDED", stdout, stderr, exitCode, null);

            if (stderr.Contains(CompileMarker, StringComparison.Ordinal))
            {
                stderr = stderr.Replace(CompileMarker, string.Empty, StringComparison.Ordinal).TrimStart();
                return new SandboxExecutionResult("FAILED", stdout, stderr, exitCode, "COMPILE_ERROR");
            }

            return new SandboxExecutionResult("FAILED", stdout, stderr, exitCode, "RUNTIME_ERROR");
        }
        finally
        {
            if (containerId is not null)
            {
                try
                {
                    await DeleteContainerAsync(containerId, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Não foi possível remover o container {ContainerId}", containerId);
                }
            }

            if (volumeCreated)
            {
                try
                {
                    await DeleteVolumeAsync(volumeName, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Não foi possível remover o volume {VolumeName}", volumeName);
                }
            }
        }
    }

    private async Task<bool> ImageExistsAsync(string image, CancellationToken cancellationToken)
    {
        using var response = await _client.GetAsync($"/images/{Uri.EscapeDataString(image)}/json", cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return false;
        response.EnsureSuccessStatusCode();
        return true;
    }

    // A API do Docker recusa PUT /archive em containers com rootfs read-only, a menos que o destino seja um volume.
    // Um volume "local" com driver tmpfs mantém o /workspace em memória (exec permitido para o binário C++).
    private async Task CreateWorkspaceVolumeAsync(string name, CancellationToken cancellationToken)
    {
        var body = new
        {
            Name = name,
            Driver = "local",
            DriverOpts = new Dictionary<string, string>
            {
                ["type"] = "tmpfs",
                ["device"] = "tmpfs",
                ["o"] = "size=32m,exec,nosuid,nodev,uid=10001,gid=10001,mode=0700"
            }
        };

        using var response = await SendJsonAsync(HttpMethod.Post, "/volumes/create", body, cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    private async Task DeleteVolumeAsync(string name, CancellationToken cancellationToken)
    {
        using var response = await _client.DeleteAsync($"/volumes/{Uri.EscapeDataString(name)}?force=true", cancellationToken);
        if (response.StatusCode != System.Net.HttpStatusCode.NotFound) response.EnsureSuccessStatusCode();
    }

    private async Task<string> CreateContainerAsync(
        string name,
        string image,
        string command,
        string workspaceVolume,
        int memoryMb,
        long nanoCpus,
        long pidsLimit,
        CancellationToken cancellationToken)
    {
        var body = new
        {
            Image = image,
            Cmd = new[] { "sh", "-c", command },
            WorkingDir = "/workspace",
            User = "10001:10001",
            Tty = false,
            OpenStdin = false,
            HostConfig = new
            {
                NetworkMode = "none",
                ReadonlyRootfs = true,
                Memory = (long)memoryMb * 1024 * 1024,
                MemorySwap = (long)memoryMb * 1024 * 1024,
                NanoCpus = nanoCpus,
                PidsLimit = pidsLimit,
                SecurityOpt = new[] { "no-new-privileges" },
                CapDrop = new[] { "ALL" },
                Binds = new[] { $"{workspaceVolume}:/workspace" },
                Tmpfs = new Dictionary<string, string>
                {
                    ["/tmp"] = "rw,nosuid,nodev,size=32m,mode=1777"
                },
                LogConfig = new
                {
                    Type = "json-file",
                    Config = new Dictionary<string, string>
                    {
                        ["max-size"] = "256k",
                        ["max-file"] = "1"
                    }
                }
            }
        };

        using var response = await SendJsonAsync(HttpMethod.Post, $"/containers/create?name={Uri.EscapeDataString(name)}", body, cancellationToken);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        return document.RootElement.GetProperty("Id").GetString()!;
    }

    private async Task StartContainerAsync(string id, CancellationToken cancellationToken)
    {
        using var response = await _client.PostAsync($"/containers/{id}/start", content: null, cancellationToken: cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    private async Task PutArchiveAsync(string id, byte[] archive, CancellationToken cancellationToken)
    {
        using var content = new ByteArrayContent(archive);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/x-tar");
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/containers/{id}/archive?path=%2Fworkspace")
        {
            Content = content
        };
        using var response = await _client.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    private async Task<int?> WaitContainerAsync(string id, CancellationToken cancellationToken)
    {
        using var response = await _client.PostAsync($"/containers/{id}/wait?condition=not-running", content: null, cancellationToken: cancellationToken);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        return document.RootElement.TryGetProperty("StatusCode", out var statusCode)
            ? statusCode.GetInt32()
            : null;
    }

    private async Task KillContainerAsync(string id, CancellationToken cancellationToken)
    {
        using var response = await _client.PostAsync($"/containers/{id}/kill", content: null, cancellationToken: cancellationToken);
        if (response.StatusCode is not (System.Net.HttpStatusCode.NoContent or System.Net.HttpStatusCode.Conflict or System.Net.HttpStatusCode.NotFound))
            response.EnsureSuccessStatusCode();
    }

    private async Task<(string Stdout, string Stderr)> GetLogsAsync(string id, CancellationToken cancellationToken)
    {
        using var response = await _client.GetAsync($"/containers/{id}/logs?stdout=true&stderr=true", cancellationToken);
        response.EnsureSuccessStatusCode();
        var data = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        return ParseMultiplexedLogs(data);
    }

    private async Task<(bool OomKilled, int? ExitCode)> InspectContainerAsync(string id, CancellationToken cancellationToken)
    {
        using var response = await _client.GetAsync($"/containers/{id}/json", cancellationToken);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        var state = document.RootElement.GetProperty("State");
        var oomKilled = state.TryGetProperty("OOMKilled", out var oom) && oom.GetBoolean();
        var exitCode = state.TryGetProperty("ExitCode", out var exit) ? exit.GetInt32() : (int?)null;
        return (oomKilled, exitCode);
    }

    private async Task DeleteContainerAsync(string id, CancellationToken cancellationToken)
    {
        using var response = await _client.DeleteAsync($"/containers/{id}?force=true&v=true", cancellationToken);
        if (response.StatusCode != System.Net.HttpStatusCode.NotFound) response.EnsureSuccessStatusCode();
    }

    private async Task<HttpResponseMessage> SendJsonAsync(HttpMethod method, string url, object body, CancellationToken cancellationToken)
    {
        var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        var request = new HttpRequestMessage(method, url) { Content = content };
        return await _client.SendAsync(request, cancellationToken);
    }

    private static (string Stdout, string Stderr) ParseMultiplexedLogs(byte[] data)
    {
        using var stdout = new MemoryStream();
        using var stderr = new MemoryStream();
        var offset = 0;
        var validFrames = true;

        while (offset + 8 <= data.Length)
        {
            var streamType = data[offset];
            var length = BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(offset + 4, 4));
            if (length < 0 || offset + 8 + length > data.Length || streamType is < 1 or > 3)
            {
                validFrames = false;
                break;
            }

            var target = streamType == 2 ? stderr : stdout;
            target.Write(data, offset + 8, length);
            offset += 8 + length;
        }

        if (!validFrames && data.Length > 0)
            return (Encoding.UTF8.GetString(data), string.Empty);

        return (Encoding.UTF8.GetString(stdout.ToArray()), Encoding.UTF8.GetString(stderr.ToArray()));
    }

    private static bool IsRuntimeOutOfMemory(string stderr)
    {
        return stderr.Contains("MemoryError", StringComparison.Ordinal)
            || stderr.Contains("java.lang.OutOfMemoryError", StringComparison.Ordinal)
            || stderr.Contains("std::bad_alloc", StringComparison.Ordinal)
            || stderr.Contains("JavaScript heap out of memory", StringComparison.Ordinal);
    }

    private static string Truncate(string value, int maxChars)
    {
        if (value.Length <= maxChars) return value;
        return value[..maxChars] + "\n[saída truncada pelo limite do sandbox]";
    }

    public void Dispose() => _client.Dispose();

    private sealed record SandboxSpec(string Image, string SourceFileName, string Command);
}
