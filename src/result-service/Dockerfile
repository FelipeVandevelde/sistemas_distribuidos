FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY ["ResultService.csproj", "./"]
RUN dotnet restore "ResultService.csproj"
COPY . .
WORKDIR "/src/"
RUN dotnet build "ResultService.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "ResultService.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "ResultService.dll"]
