var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);

builder.Services.AddSingleton<WorkerHealthState>();
builder.Services.AddSingleton<DockerEngineClient>();
builder.Services.AddHttpClient<ResultServiceClient>(client =>
{
    client.BaseAddress = new Uri(builder.Configuration["ResultService:BaseUrl"] ?? "http://result-service:8080");
    client.Timeout = TimeSpan.FromSeconds(5);
});
builder.Services.AddHostedService<JobConsumer>();

var app = builder.Build();

app.MapGet("/health", (WorkerHealthState health) =>
{
    return health.DockerReady && health.RabbitReady
        ? Results.Ok(new { status = "Healthy", service = "execution-worker", workerId = health.WorkerId })
        : Results.Json(new
        {
            status = "Unhealthy",
            service = "execution-worker",
            workerId = health.WorkerId,
            docker = health.DockerReady,
            rabbitMq = health.RabbitReady
        }, statusCode: 503);
});

app.Run();
