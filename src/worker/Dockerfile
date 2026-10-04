FROM mcr.microsoft.com/dotnet/runtime:9.0 AS base
WORKDIR /app
# Instalar o Docker CLI para que o Worker possa iniciar sandboxes usando comandos no shell
RUN apt-get update && apt-get install -y docker.io && rm -rf /var/lib/apt/lists/*

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY ["ExecutionWorker.csproj", "./"]
RUN dotnet restore "ExecutionWorker.csproj"
COPY . .
WORKDIR "/src/"
RUN dotnet build "ExecutionWorker.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "ExecutionWorker.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "ExecutionWorker.dll"]
