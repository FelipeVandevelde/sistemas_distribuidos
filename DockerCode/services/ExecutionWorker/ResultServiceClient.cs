using System.Net;
using System.Net.Http.Json;

public sealed class ResultServiceClient(HttpClient client)
{
    public async Task<ClaimResponse?> ClaimAsync(Guid jobId, string workerId, int leaseSeconds, CancellationToken cancellationToken)
    {
        using var response = await client.PostAsJsonAsync(
            $"/internal/jobs/{jobId}/claim",
            new ClaimRequest(workerId, leaseSeconds),
            cancellationToken);

        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<ClaimResponse>(cancellationToken: cancellationToken);
    }

    public async Task<bool> HeartbeatAsync(
        Guid jobId,
        string workerId,
        Guid leaseToken,
        int leaseSeconds,
        CancellationToken cancellationToken)
    {
        using var response = await client.PostAsJsonAsync(
            $"/internal/jobs/{jobId}/heartbeat",
            new HeartbeatRequest(workerId, leaseToken, leaseSeconds),
            cancellationToken);
        return response.IsSuccessStatusCode;
    }

    public async Task<bool> CompleteAsync(
        Guid jobId,
        CompleteJobRequest request,
        CancellationToken cancellationToken)
    {
        using var response = await client.PostAsJsonAsync(
            $"/internal/jobs/{jobId}/complete",
            request,
            cancellationToken);
        return response.IsSuccessStatusCode;
    }
}
