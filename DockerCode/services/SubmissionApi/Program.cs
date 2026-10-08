using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using RabbitMQ.Client;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);

builder.Services.AddCors(options =>
{
    options.AddPolicy("dev", policy =>
    {
        var origin = builder.Configuration["Cors:AllowedOrigins:0"] ?? "http://localhost:5173";
        policy.WithOrigins(origin).AllowAnyHeader().AllowAnyMethod();
    });
});

builder.Services.AddHttpClient<ResultServiceClient>(client =>
{
    client.BaseAddress = new Uri(builder.Configuration["ResultService:BaseUrl"] ?? "http://result-service:8080");
    client.Timeout = TimeSpan.FromSeconds(5);
});

builder.Services.AddSingleton<RabbitPublisher>();

var app = builder.Build();
app.UseExceptionHandler(errorApp =>
{
    errorApp.Run(async context =>
    {
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new { message = "Ocorreu uma falha interna na API." });
    });
});
app.UseCors("dev");

app.MapPost("/api/jobs", async (
    HttpContext httpContext,
    SubmitJobRequest request,
    ResultServiceClient resultService,
    RabbitPublisher publisher,
    ILogger<Program> logger,
    CancellationToken cancellationToken) =>
{
    var validationError = Validate(request);
    if (validationError is not null)
    {
        return Results.BadRequest(new { message = validationError });
    }

    var correlationId = httpContext.Request.Headers["X-Correlation-ID"].FirstOrDefault();
    if (string.IsNullOrWhiteSpace(correlationId)) correlationId = Guid.NewGuid().ToString("N");

    using var scope = logger.BeginScope(new Dictionary<string, object>
    {
        ["service"] = "submission-api",
        ["correlation_id"] = correlationId
    });

    try
    {
        var created = await resultService.CreateAsync(new CreateJobRequest(
            request.Language.Trim().ToLowerInvariant(),
            request.SourceCode,
            request.Stdin ?? string.Empty,
            correlationId), cancellationToken);

        try
        {
            publisher.Publish(new ExecutionMessage(created.JobId, correlationId));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Falha ao publicar Job {JobId} no RabbitMQ", created.JobId);
            await resultService.MarkInfrastructureFailureAsync(
                created.JobId,
                "BROKER_UNAVAILABLE",
                "Não foi possível encaminhar o Job para execução.",
                cancellationToken);

            return Results.Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Fila de execução indisponível",
                detail: "Não foi possível encaminhar a execução. Tente novamente em instantes.");
        }

        logger.LogInformation("Job {JobId} criado com status QUEUED", created.JobId);
        httpContext.Response.Headers["X-Correlation-ID"] = correlationId;
        return Results.Accepted($"/api/jobs/{created.JobId}", new { jobId = created.JobId, status = "QUEUED" });
    }
    catch (HttpRequestException ex)
    {
        logger.LogError(ex, "Result Service indisponível durante submissão");
        return Results.Problem(
            statusCode: StatusCodes.Status503ServiceUnavailable,
            title: "Serviço de resultados indisponível",
            detail: "Não foi possível registrar a execução. Tente novamente em instantes.");
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Falha inesperada durante submissão");
        return Results.Problem(
            statusCode: StatusCodes.Status500InternalServerError,
            title: "Erro interno",
            detail: "Ocorreu uma falha inesperada ao criar a execução.");
    }
});

app.MapGet("/api/jobs/{id:guid}", async (
    Guid id,
    ResultServiceClient resultService,
    ILogger<Program> logger,
    CancellationToken cancellationToken) =>
{
    try
    {
        var job = await resultService.GetAsync(id, cancellationToken);
        return job is null
            ? Results.NotFound(new { message = "Job não encontrado." })
            : Results.Ok(new
            {
                jobId = job.JobId,
                status = job.Status,
                stdout = job.Stdout,
                stderr = job.Stderr,
                exitCode = job.ExitCode,
                failureReason = job.FailureReason,
                createdAt = job.CreatedAt,
                startedAt = job.StartedAt,
                finishedAt = job.FinishedAt
            });
    }
    catch (HttpRequestException ex)
    {
        logger.LogError(ex, "Result Service indisponível durante consulta do Job {JobId}", id);
        return Results.Problem(
            statusCode: StatusCodes.Status503ServiceUnavailable,
            title: "Serviço de resultados indisponível",
            detail: "Não foi possível consultar a execução no momento.");
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Falha inesperada durante consulta do Job {JobId}", id);
        return Results.Problem(
            statusCode: StatusCodes.Status500InternalServerError,
            title: "Erro interno",
            detail: "Ocorreu uma falha inesperada ao consultar a execução.");
    }
});

app.MapGet("/health", async (ResultServiceClient resultService, RabbitPublisher publisher, CancellationToken cancellationToken) =>
{
    var resultHealthy = await resultService.IsHealthyAsync(cancellationToken);
    var rabbitHealthy = publisher.IsHealthy;

    return resultHealthy && rabbitHealthy
        ? Results.Ok(new { status = "Healthy", service = "submission-api" })
        : Results.Json(new { status = "Unhealthy", service = "submission-api", resultService = resultHealthy, rabbitMq = rabbitHealthy }, statusCode: 503);
});

app.Run();

static string? Validate(SubmitJobRequest request)
{
    var supported = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "python", "javascript", "java", "cpp"
    };

    if (string.IsNullOrWhiteSpace(request.Language) || !supported.Contains(request.Language))
        return "Linguagem não suportada. Use python, javascript, java ou cpp.";

    if (string.IsNullOrWhiteSpace(request.SourceCode))
        return "O código não pode estar vazio.";

    if (Encoding.UTF8.GetByteCount(request.SourceCode) > 64 * 1024)
        return "O código excede o limite de 64 KiB.";

    if (Encoding.UTF8.GetByteCount(request.Stdin ?? string.Empty) > 32 * 1024)
        return "O stdin excede o limite de 32 KiB.";

    return null;
}

record SubmitJobRequest(string Language, string SourceCode, string? Stdin);
record CreateJobRequest(string Language, string SourceCode, string Stdin, string CorrelationId);
record CreatedJobResponse(Guid JobId, string Status);
record ExecutionMessage(Guid JobId, string CorrelationId);
record JobResponse(
    Guid JobId,
    string Status,
    string? Stdout,
    string? Stderr,
    int? ExitCode,
    string? FailureReason,
    DateTime CreatedAt,
    DateTime? StartedAt,
    DateTime? FinishedAt);

sealed class ResultServiceClient(HttpClient client)
{
    public async Task<CreatedJobResponse> CreateAsync(CreateJobRequest request, CancellationToken cancellationToken)
    {
        using var response = await client.PostAsJsonAsync("/internal/jobs", request, cancellationToken);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<CreatedJobResponse>(cancellationToken: cancellationToken))!;
    }

    public async Task<JobResponse?> GetAsync(Guid jobId, CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync($"/internal/jobs/{jobId}", cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JobResponse>(cancellationToken: cancellationToken);
    }

    public async Task MarkInfrastructureFailureAsync(
        Guid jobId,
        string reason,
        string stderr,
        CancellationToken cancellationToken)
    {
        using var response = await client.PostAsJsonAsync(
            $"/internal/jobs/{jobId}/mark-failed",
            new { failureReason = reason, stderr },
            cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    public async Task<bool> IsHealthyAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await client.GetAsync("/health", cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }
}

sealed class RabbitPublisher : IDisposable
{
    private readonly object _sync = new();
    private readonly ConnectionFactory _factory;
    private readonly string _queue;
    private IConnection? _connection;
    private IModel? _channel;

    public RabbitPublisher(IConfiguration configuration)
    {
        _queue = configuration["RabbitMq:Queue"] ?? "execution.jobs";
        _factory = new ConnectionFactory
        {
            HostName = configuration["RabbitMq:Host"] ?? "rabbitmq",
            Port = configuration.GetValue("RabbitMq:Port", 5672),
            UserName = configuration["RabbitMq:User"] ?? "dockercode",
            Password = configuration["RabbitMq:Password"] ?? "dockercode",
            AutomaticRecoveryEnabled = true,
            NetworkRecoveryInterval = TimeSpan.FromSeconds(2)
        };
    }

    public bool IsHealthy
    {
        get
        {
            lock (_sync)
            {
                try
                {
                    EnsureChannel();
                    return _connection?.IsOpen == true && _channel?.IsOpen == true;
                }
                catch
                {
                    return false;
                }
            }
        }
    }

    public void Publish(ExecutionMessage message)
    {
        lock (_sync)
        {
            EnsureChannel();
            var body = JsonSerializer.SerializeToUtf8Bytes(message);
            var properties = _channel!.CreateBasicProperties();
            properties.Persistent = true;
            properties.ContentType = "application/json";
            properties.CorrelationId = message.CorrelationId;
            properties.MessageId = message.JobId.ToString();

            _channel.BasicPublish("", _queue, false, properties, body);
            _channel.WaitForConfirmsOrDie(TimeSpan.FromSeconds(5));
        }
    }

    private void EnsureChannel()
    {
        if (_connection?.IsOpen == true && _channel?.IsOpen == true) return;

        _channel?.Dispose();
        _connection?.Dispose();

        _connection = _factory.CreateConnection();
        _channel = _connection.CreateModel();
        _channel.QueueDeclare(_queue, durable: true, exclusive: false, autoDelete: false, arguments: null);
        _channel.ConfirmSelect();
    }

    public void Dispose()
    {
        lock (_sync)
        {
            _channel?.Dispose();
            _connection?.Dispose();
        }
    }
}
