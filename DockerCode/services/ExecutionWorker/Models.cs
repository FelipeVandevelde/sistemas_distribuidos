public sealed record ExecutionMessage(Guid JobId, string CorrelationId);

public sealed record ClaimRequest(string WorkerId, int LeaseSeconds);

public sealed record ClaimResponse(
    bool Exists,
    bool Acquired,
    string? Status,
    Guid? LeaseToken,
    string? Language,
    string? SourceCode,
    string? Stdin,
    string? CorrelationId,
    DateTime? LeaseUntil);

public sealed record HeartbeatRequest(string WorkerId, Guid LeaseToken, int LeaseSeconds);

public sealed record CompleteJobRequest(
    string WorkerId,
    Guid LeaseToken,
    string Status,
    string? Stdout,
    string? Stderr,
    int? ExitCode,
    string? FailureReason);

public sealed record SandboxExecutionResult(
    string Status,
    string Stdout,
    string Stderr,
    int? ExitCode,
    string? FailureReason);
