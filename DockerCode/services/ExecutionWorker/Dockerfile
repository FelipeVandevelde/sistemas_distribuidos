FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY services/ExecutionWorker/ExecutionWorker.csproj services/ExecutionWorker/
RUN dotnet restore services/ExecutionWorker/ExecutionWorker.csproj
COPY services/ExecutionWorker/ services/ExecutionWorker/
RUN dotnet publish services/ExecutionWorker/ExecutionWorker.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "ExecutionWorker.dll"]
