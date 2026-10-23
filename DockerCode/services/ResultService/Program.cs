using Npgsql;
using NpgsqlTypes;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);

builder.Services.AddSingleton<JobRepository>();

var app = builder.Build();

var repository = app.Services.GetRequiredService<JobRepository>();
await repository.InitializeWithRetryAsync(app.Lifetime.ApplicationStopping);

app.MapPost("/internal/jobs", async (CreateJobRequest request, JobRepository repo, CancellationToken cancellationToken) =>
{
    var job = await repo.CreateAsync(request, cancellationToken);
    return Results.Ok(new { jobId = job.JobId, status = job.Status });
});

app.MapGet("/internal/jobs/{id:guid}", async (Guid id, JobRepository repo, CancellationToken cancellationToken) =>
{
    var job = await repo.GetAsync(id, cancellationToken);
    return job is null ? Results.NotFound() : Results.Ok(job);
});

app.MapPost("/internal/jobs/{id:guid}/claim", async (
    Guid id,
    ClaimRequest request,
    JobRepository repo,
    CancellationToken cancellationToken) =>
{
    var result = await repo.ClaimAsync(id, request.WorkerId, Math.Clamp(request.LeaseSeconds, 5, 120), cancellationToken);
    return result.Exists ? Results.Ok(result) : Results.NotFound();
});

app.MapPost("/internal/jobs/{id:guid}/heartbeat", async (
    Guid id,
    HeartbeatRequest request,
    JobRepository repo,
    CancellationToken cancellationToken) =>
{
    var renewed = await repo.HeartbeatAsync(id, request.WorkerId, request.LeaseToken, Math.Clamp(request.LeaseSeconds, 5, 120), cancellationToken);
    return renewed ? Results.NoContent() : Results.Conflict(new { message = "Lease não está mais ativo." });
});

app.MapPost("/internal/jobs/{id:guid}/complete", async (
    Guid id,
    CompleteJobRequest request,
    JobRepository repo,
    CancellationToken cancellationToken) =>
{
    if (request.Status is not ("SUCCEEDED" or "FAILED" or "TIMEOUT"))
        return Results.BadRequest(new { message = "Estado final inválido." });

    var completed = await repo.CompleteAsync(id, request, cancellationToken);
    return completed ? Results.NoContent() : Results.Conflict(new { message = "Tentativa não possui mais direito de finalizar o Job." });
});

app.MapPost("/internal/jobs/{id:guid}/mark-failed", async (
    Guid id,
    MarkFailedRequest request,
    JobRepository repo,
    CancellationToken cancellationToken) =>
{
    var updated = await repo.MarkQueuedAsFailedAsync(id, request.FailureReason, request.Stderr, cancellationToken);
    return updated ? Results.NoContent() : Results.Conflict(new { message = "Job não está mais em QUEUED." });
});

app.MapGet("/health", async (JobRepository repo, CancellationToken cancellationToken) =>
{
    try
    {
        await repo.CheckHealthAsync(cancellationToken);
        return Results.Ok(new { status = "Healthy", service = "result-service" });
    }
    catch
    {
        return Results.Json(new { status = "Unhealthy", service = "result-service" }, statusCode: 503);
    }
});

app.Run();

record CreateJobRequest(string Language, string SourceCode, string Stdin, string CorrelationId);
record ClaimRequest(string WorkerId, int LeaseSeconds = 20);
record HeartbeatRequest(string WorkerId, Guid LeaseToken, int LeaseSeconds = 20);
record MarkFailedRequest(string FailureReason, string Stderr);
record CompleteJobRequest(
    string WorkerId,
    Guid LeaseToken,
    string Status,
    string? Stdout,
    string? Stderr,
    int? ExitCode,
    string? FailureReason);

record JobRecord(
    Guid JobId,
    string Language,
    string SourceCode,
    string Stdin,
    string Status,
    string? Stdout,
    string? Stderr,
    int? ExitCode,
    string? FailureReason,
    string CorrelationId,
    string? WorkerId,
    DateTime? LeaseUntil,
    Guid? LeaseToken,
    DateTime CreatedAt,
    DateTime? StartedAt,
    DateTime? FinishedAt);

record ClaimResult(
    bool Exists,
    bool Acquired,
    string? Status,
    Guid? LeaseToken,
    string? Language,
    string? SourceCode,
    string? Stdin,
    string? CorrelationId,
    DateTime? LeaseUntil);

sealed class JobRepository(IConfiguration configuration, ILogger<JobRepository> logger)
{
    private readonly string _connectionString = configuration.GetConnectionString("Postgres")
        ?? "Host=postgres;Port=5432;Database=dockercode;Username=dockercode;Password=dockercode";

    public async Task InitializeWithRetryAsync(CancellationToken cancellationToken)
    {
        Exception? last = null;
        for (var attempt = 1; attempt <= 30 && !cancellationToken.IsCancellationRequested; attempt++)
        {
            try
            {
                await InitializeAsync(cancellationToken);
                logger.LogInformation("Banco do Result Service inicializado");
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                logger.LogWarning(ex, "PostgreSQL ainda indisponível. Tentativa {Attempt}/30", attempt);
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            }
        }

        throw new InvalidOperationException("Não foi possível inicializar o PostgreSQL.", last);
    }

    private async Task InitializeAsync(CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS jobs (
                id uuid PRIMARY KEY,
                language varchar(32) NOT NULL,
                source_code text NOT NULL,
                stdin text NOT NULL DEFAULT '',
                status varchar(16) NOT NULL,
                created_at timestamptz NOT NULL,
                started_at timestamptz NULL,
                finished_at timestamptz NULL,
                worker_id varchar(128) NULL,
                lease_until timestamptz NULL,
                lease_token uuid NULL,
                stdout text NULL,
                stderr text NULL,
                exit_code integer NULL,
                failure_reason varchar(64) NULL,
                correlation_id varchar(128) NOT NULL,
                attempt_count integer NOT NULL DEFAULT 0,
                CONSTRAINT jobs_status_check CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','TIMEOUT'))
            );
            CREATE INDEX IF NOT EXISTS ix_jobs_status_lease ON jobs(status, lease_until);
            """;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<JobRecord> CreateAsync(CreateJobRequest request, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid();
        var now = DateTime.UtcNow;

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO jobs(id, language, source_code, stdin, status, created_at, correlation_id)
            VALUES (@id, @language, @sourceCode, @stdin, 'QUEUED', @createdAt, @correlationId);
            """;
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("language", request.Language);
        command.Parameters.AddWithValue("sourceCode", request.SourceCode);
        command.Parameters.AddWithValue("stdin", request.Stdin);
        command.Parameters.AddWithValue("createdAt", now);
        command.Parameters.AddWithValue("correlationId", request.CorrelationId);
        await command.ExecuteNonQueryAsync(cancellationToken);

        logger.LogInformation("Job {JobId} persistido em QUEUED", id);
        return new JobRecord(id, request.Language, request.SourceCode, request.Stdin, "QUEUED", null, null, null, null, request.CorrelationId, null, null, null, now, null, null);
    }

    public async Task<JobRecord?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, language, source_code, stdin, status, stdout, stderr, exit_code, failure_reason,
                   correlation_id, worker_id, lease_until, lease_token, created_at, started_at, finished_at
            FROM jobs WHERE id = @id;
            """;
        command.Parameters.AddWithValue("id", id);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return ReadJob(reader);
    }

    public async Task<ClaimResult> ClaimAsync(Guid id, string workerId, int leaseSeconds, CancellationToken cancellationToken)
    {
        var token = Guid.NewGuid();
        var leaseUntil = DateTime.UtcNow.AddSeconds(leaseSeconds);

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE jobs
            SET status = 'RUNNING',
                worker_id = @workerId,
                lease_token = @leaseToken,
                lease_until = @leaseUntil,
                started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                attempt_count = attempt_count + 1
            WHERE id = @id
              AND attempt_count < 3
              AND (status = 'QUEUED' OR (status = 'RUNNING' AND lease_until < CURRENT_TIMESTAMP))
            RETURNING status, language, source_code, stdin, correlation_id, lease_token, lease_until;
            """;
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("workerId", workerId);
        command.Parameters.AddWithValue("leaseToken", token);
        command.Parameters.AddWithValue("leaseUntil", leaseUntil);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (await reader.ReadAsync(cancellationToken))
        {
            logger.LogInformation("Job {JobId} adquirido por Worker {WorkerId} com lease {LeaseToken}", id, workerId, token);
            return new ClaimResult(
                true,
                true,
                reader.GetString(0),
                reader.GetGuid(5),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetDateTime(6));
        }

        await reader.CloseAsync();

        await using var expireCommand = connection.CreateCommand();
        expireCommand.CommandText = """
            UPDATE jobs
            SET status = 'FAILED',
                failure_reason = 'INFRA_ERROR',
                stderr = COALESCE(stderr, 'Limite máximo de tentativas de execução excedido.'),
                finished_at = CURRENT_TIMESTAMP,
                lease_until = NULL
            WHERE id = @id
              AND status = 'RUNNING'
              AND lease_until < CURRENT_TIMESTAMP
              AND attempt_count >= 3;
            """;
        expireCommand.Parameters.AddWithValue("id", id);
        await expireCommand.ExecuteNonQueryAsync(cancellationToken);
        await using var stateCommand = connection.CreateCommand();
        stateCommand.CommandText = "SELECT status, lease_until FROM jobs WHERE id = @id;";
        stateCommand.Parameters.AddWithValue("id", id);
        await using var stateReader = await stateCommand.ExecuteReaderAsync(cancellationToken);
        if (!await stateReader.ReadAsync(cancellationToken))
            return new ClaimResult(false, false, null, null, null, null, null, null, null);

        var status = stateReader.GetString(0);
        DateTime? currentLease = stateReader.IsDBNull(1) ? (DateTime?)null : stateReader.GetDateTime(1);
        return new ClaimResult(true, false, status, null, null, null, null, null, currentLease);
    }

    public async Task<bool> HeartbeatAsync(Guid id, string workerId, Guid leaseToken, int leaseSeconds, CancellationToken cancellationToken)
    {
        var leaseUntil = DateTime.UtcNow.AddSeconds(leaseSeconds);
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE jobs
            SET lease_until = @leaseUntil
            WHERE id = @id AND status = 'RUNNING' AND worker_id = @workerId AND lease_token = @leaseToken;
            """;
        command.Parameters.AddWithValue("leaseUntil", leaseUntil);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("workerId", workerId);
        command.Parameters.AddWithValue("leaseToken", leaseToken);
        return await command.ExecuteNonQueryAsync(cancellationToken) == 1;
    }

    public async Task<bool> CompleteAsync(Guid id, CompleteJobRequest request, CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE jobs
            SET status = @status,
                stdout = @stdout,
                stderr = @stderr,
                exit_code = @exitCode,
                failure_reason = @failureReason,
                finished_at = CURRENT_TIMESTAMP,
                lease_until = NULL
            WHERE id = @id
              AND status = 'RUNNING'
              AND worker_id = @workerId
              AND lease_token = @leaseToken;
            """;
        command.Parameters.AddWithValue("status", request.Status);
        command.Parameters.Add("stdout", NpgsqlDbType.Text).Value = (object?)request.Stdout ?? DBNull.Value;
        command.Parameters.Add("stderr", NpgsqlDbType.Text).Value = (object?)request.Stderr ?? DBNull.Value;
        command.Parameters.Add("exitCode", NpgsqlDbType.Integer).Value = (object?)request.ExitCode ?? DBNull.Value;
        command.Parameters.Add("failureReason", NpgsqlDbType.Varchar).Value = (object?)request.FailureReason ?? DBNull.Value;
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("workerId", request.WorkerId);
        command.Parameters.AddWithValue("leaseToken", request.LeaseToken);
        var updated = await command.ExecuteNonQueryAsync(cancellationToken) == 1;

        if (updated) logger.LogInformation("Job {JobId} finalizado em {Status}", id, request.Status);
        return updated;
    }

    public async Task<bool> MarkQueuedAsFailedAsync(Guid id, string failureReason, string stderr, CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE jobs
            SET status = 'FAILED', failure_reason = @failureReason, stderr = @stderr, finished_at = CURRENT_TIMESTAMP
            WHERE id = @id AND status = 'QUEUED';
            """;
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("failureReason", failureReason);
        command.Parameters.AddWithValue("stderr", stderr);
        return await command.ExecuteNonQueryAsync(cancellationToken) == 1;
    }

    public async Task CheckHealthAsync(CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT 1;";
        await command.ExecuteScalarAsync(cancellationToken);
    }

    private static JobRecord ReadJob(NpgsqlDataReader reader)
    {
        return new JobRecord(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.IsDBNull(7) ? null : reader.GetInt32(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.IsDBNull(11) ? null : reader.GetDateTime(11),
            reader.IsDBNull(12) ? null : reader.GetGuid(12),
            reader.GetDateTime(13),
            reader.IsDBNull(14) ? null : reader.GetDateTime(14),
            reader.IsDBNull(15) ? null : reader.GetDateTime(15));
    }
}
