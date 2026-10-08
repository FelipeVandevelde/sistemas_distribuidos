using System.Text.Json;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

public sealed class JobConsumer : BackgroundService
{
    private const int LeaseSeconds = 20;
    private readonly IConfiguration _configuration;
    private readonly ResultServiceClient _resultService;
    private readonly DockerEngineClient _docker;
    private readonly WorkerHealthState _health;
    private readonly ILogger<JobConsumer> _logger;

    public JobConsumer(
        IConfiguration configuration,
        ResultServiceClient resultService,
        DockerEngineClient docker,
        WorkerHealthState health,
        ILogger<JobConsumer> logger)
    {
        _configuration = configuration;
        _resultService = resultService;
        _docker = docker;
        _health = health;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await _docker.EnsureSandboxImagesAsync(stoppingToken);
                _health.DockerReady = true;
                break;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _health.DockerReady = false;
                _logger.LogError(ex, "Docker indisponível ou falha ao preparar imagens de sandbox. Nova tentativa em 3s.");
                await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken);
            }
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            IConnection? connection = null;
            IModel? channel = null;

            try
            {
                var queue = _configuration["RabbitMq:Queue"] ?? "execution.jobs";
                var factory = new ConnectionFactory
                {
                    HostName = _configuration["RabbitMq:Host"] ?? "rabbitmq",
                    Port = _configuration.GetValue("RabbitMq:Port", 5672),
                    UserName = _configuration["RabbitMq:User"] ?? "dockercode",
                    Password = _configuration["RabbitMq:Password"] ?? "dockercode",
                    AutomaticRecoveryEnabled = true,
                    NetworkRecoveryInterval = TimeSpan.FromSeconds(2),
                    DispatchConsumersAsync = true
                };

                connection = factory.CreateConnection();
                channel = connection.CreateModel();
                channel.QueueDeclare(queue, durable: true, exclusive: false, autoDelete: false, arguments: null);
                channel.BasicQos(0, 1, false);
                _health.RabbitReady = true;

                var consumer = new AsyncEventingBasicConsumer(channel);
                consumer.Received += async (_, eventArgs) =>
                {
                    await HandleMessageAsync(channel, eventArgs, stoppingToken);
                };

                channel.BasicConsume(queue, autoAck: false, consumer);
                _logger.LogInformation("Worker {WorkerId} consumindo fila {Queue}", _health.WorkerId, queue);

                while (!stoppingToken.IsCancellationRequested && connection.IsOpen && channel.IsOpen)
                    await Task.Delay(1000, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _health.RabbitReady = false;
                _logger.LogError(ex, "Conexão com RabbitMQ falhou. Nova tentativa em 3s.");
                await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken);
            }
            finally
            {
                _health.RabbitReady = false;
                channel?.Dispose();
                connection?.Dispose();
            }
        }
    }

    private async Task HandleMessageAsync(IModel channel, BasicDeliverEventArgs eventArgs, CancellationToken stoppingToken)
    {
        ExecutionMessage? message;
        try
        {
            message = JsonSerializer.Deserialize<ExecutionMessage>(eventArgs.Body.Span);
            if (message is null) throw new JsonException("Mensagem vazia.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Mensagem inválida recebida do RabbitMQ");
            channel.BasicReject(eventArgs.DeliveryTag, requeue: false);
            return;
        }

        using var scope = _logger.BeginScope(new Dictionary<string, object>
        {
            ["service"] = "execution-worker",
            ["worker_id"] = _health.WorkerId,
            ["job_id"] = message.JobId,
            ["correlation_id"] = message.CorrelationId
        });

        ClaimResponse? claim;
        try
        {
            claim = await _resultService.ClaimAsync(message.JobId, _health.WorkerId, LeaseSeconds, stoppingToken);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Result Service indisponível durante claim do Job {JobId}", message.JobId);
            await RequeueWithDelayAsync(channel, eventArgs.DeliveryTag, stoppingToken);
            return;
        }

        if (claim is null)
        {
            _logger.LogWarning("Job {JobId} não existe; descartando mensagem", message.JobId);
            channel.BasicAck(eventArgs.DeliveryTag, false);
            return;
        }

        if (!claim.Acquired)
        {
            if (claim.Status is "SUCCEEDED" or "FAILED" or "TIMEOUT")
            {
                _logger.LogInformation("Mensagem duplicada de Job terminal {JobId}; confirmando sem reexecutar", message.JobId);
                channel.BasicAck(eventArgs.DeliveryTag, false);
                return;
            }

            await RequeueWithDelayAsync(channel, eventArgs.DeliveryTag, stoppingToken);
            return;
        }

        if (claim.LeaseToken is null || claim.Language is null || claim.SourceCode is null)
        {
            _logger.LogError("Claim do Job {JobId} retornou dados incompletos", message.JobId);
            channel.BasicNack(eventArgs.DeliveryTag, false, requeue: true);
            return;
        }

        var leaseToken = claim.LeaseToken.Value;
        using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var heartbeatTask = RunHeartbeatAsync(message.JobId, leaseToken, heartbeatCts.Token);

        try
        {
            _logger.LogInformation("Executando Job {JobId} ({Language})", message.JobId, claim.Language);
            SandboxExecutionResult result;

            try
            {
                result = await _docker.ExecuteAsync(
                    message.JobId,
                    claim.Language,
                    claim.SourceCode,
                    claim.Stdin ?? string.Empty,
                    stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Falha de infraestrutura durante execução do Job {JobId}", message.JobId);
                result = new SandboxExecutionResult(
                    "FAILED",
                    string.Empty,
                    "Falha de infraestrutura ao executar o sandbox Docker.",
                    null,
                    "INFRA_ERROR");
            }

            var saved = await _resultService.CompleteAsync(
                message.JobId,
                new CompleteJobRequest(
                    _health.WorkerId,
                    leaseToken,
                    result.Status,
                    result.Stdout,
                    result.Stderr,
                    result.ExitCode,
                    result.FailureReason),
                stoppingToken);

            if (saved)
            {
                channel.BasicAck(eventArgs.DeliveryTag, false);
                _logger.LogInformation("Job {JobId} persistido em {Status} e mensagem confirmada", message.JobId, result.Status);
            }
            else
            {
                // Outra tentativa ganhou o lease. Este resultado antigo não deve sobrescrever o atual.
                channel.BasicAck(eventArgs.DeliveryTag, false);
                _logger.LogWarning("Resultado do Job {JobId} rejeitado por lease antigo; mensagem confirmada sem sobrescrever", message.JobId);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Sem ACK: o RabbitMQ poderá redeliver quando a conexão do Worker for encerrada.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Falha ao persistir resultado do Job {JobId}; mensagem será reenfileirada", message.JobId);
            if (channel.IsOpen) channel.BasicNack(eventArgs.DeliveryTag, false, requeue: true);
        }
        finally
        {
            heartbeatCts.Cancel();
            try
            {
                await heartbeatTask;
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Heartbeat do Job {JobId} encerrou com falha", message.JobId);
            }
        }
    }

    private async Task RunHeartbeatAsync(Guid jobId, Guid leaseToken, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
            var renewed = await _resultService.HeartbeatAsync(jobId, _health.WorkerId, leaseToken, LeaseSeconds, cancellationToken);
            if (!renewed)
            {
                _logger.LogWarning("Lease do Job {JobId} não pôde ser renovado", jobId);
                return;
            }
        }
    }

    private static async Task RequeueWithDelayAsync(IModel channel, ulong deliveryTag, CancellationToken cancellationToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
        if (channel.IsOpen) channel.BasicNack(deliveryTag, false, requeue: true);
    }
}
