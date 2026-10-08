public sealed class WorkerHealthState
{
    public WorkerHealthState(IConfiguration configuration)
    {
        WorkerId = configuration["Worker:Id"]
            ?? $"worker-{Environment.MachineName}-{Guid.NewGuid().ToString("N")[..8]}";
    }

    public string WorkerId { get; }
    public volatile bool DockerReady;
    public volatile bool RabbitReady;
}
