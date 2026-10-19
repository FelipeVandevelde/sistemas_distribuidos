# Deploy do DockerCode no Azure

Guia para publicar o sistema completo em uma **máquina virtual Linux no Azure** executando o mesmo `docker-compose.yml` usado localmente.

> [!IMPORTANT]
> Este roteiro **não foi executado em uma assinatura Azure real** durante o desenvolvimento. Os comandos seguem a documentação do Azure CLI e do Docker; ajuste nomes/regiões ao seu ambiente e valide cada etapa. A aplicação em si (compose + smoke test) foi validada localmente — ver [VALIDATION.md](../VALIDATION.md).

## 1. Por que uma VM (e não Container Apps / AKS)?

O **Execution Worker** cria um container de sandbox por Job conversando com o Docker Engine pelo socket `/var/run/docker.sock`. Isso exige acesso ao daemon Docker do host:

| Serviço Azure | Serve? | Motivo |
|---|---|---|
| **VM Linux + Docker Compose** | ✅ | Acesso total ao Docker Engine; é o que o projeto usa localmente |
| Azure Container Apps / ACI | ❌ | Não expõem o Docker socket ao container |
| AKS | ⚠️ | Exigiria reescrever o Worker (Jobs do Kubernetes / gVisor); fora do escopo desta entrega |

> [!WARNING]
> Quem acessa o Docker socket tem, na prática, **root na VM**. Use uma VM dedicada ao projeto e nunca exponha o socket nem as portas internas na internet.

## 2. Arquitetura na nuvem

```text
Internet ──:8080──▶ [ NSG ] ──▶ VM Ubuntu (Docker Compose)
                                  ├─ frontend (Nginx)  :8080
                                  ├─ submission-api-1/2
                                  ├─ result-service ──▶ postgres
                                  ├─ rabbitmq
                                  └─ worker-1/2 ──▶ docker.sock ──▶ sandboxes efêmeros
```

## 3. Pré-requisitos

- Assinatura Azure ativa.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) instalado e autenticado:

```powershell
az login
az account set --subscription "<ID-ou-nome-da-assinatura>"
```

## 4. Dimensionamento

| Item | Recomendado | Observação |
|---|---|---|
| Tamanho da VM | `Standard_D2s_v5` (2 vCPU / 8 GiB) | mínimo funcional: 2 vCPU / 4 GiB (`Standard_B2s` é apertado: Java + PostgreSQL + RabbitMQ + 3 serviços .NET) |
| Disco do SO | 64 GiB | as 4 imagens de sandbox (`gcc`, `temurin`, `node`, `python`) + imagens .NET ocupam alguns GiB |
| Sistema | Ubuntu Server 22.04 LTS | |
| Região | `brazilsouth` | escolha a mais próxima/disponível na sua assinatura |

## 5. Criar a infraestrutura

Os comandos abaixo usam PowerShell; em bash troque `$VAR = ...` por `VAR=...`.

```powershell
$RG   = "rg-dockercode"
$LOC  = "brazilsouth"
$VM   = "vm-dockercode"

# Grupo de recursos
az group create --name $RG --location $LOC

# VM Ubuntu (gera chave SSH em ~/.ssh se ainda não existir)
az vm create `
  --resource-group $RG `
  --name $VM `
  --image Ubuntu2204 `
  --size Standard_D2s_v5 `
  --os-disk-size-gb 64 `
  --admin-username azureuser `
  --generate-ssh-keys `
  --public-ip-sku Standard

# Libera somente a porta do front-end (Nginx)
az vm open-port --resource-group $RG --name $VM --port 8080 --priority 1010
```

Anote o `publicIpAddress` retornado (ou consulte depois):

```powershell
az vm show -d -g $RG -n $VM --query publicIps -o tsv
```

### Regras de rede (NSG)

| Porta | Ação | Motivo |
|---|---|---|
| 22 (SSH) | **restringir ao seu IP** | o `az vm create` abre para qualquer origem por padrão |
| 8080 | liberar | front-end + `/api` via Nginx |
| 8081 | **não liberar** | Submission API direta (só para desenvolvimento) |
| 15672 | **não liberar** | RabbitMQ Management com credencial fraca por padrão |

> [!NOTE]
> O `docker-compose.yml` publica `8081` e `15672` no host, mas elas só ficam acessíveis pela internet se o NSG permitir. Mantenha-as fechadas; para ver o painel do RabbitMQ use um túnel SSH (seção 9).

Restringir o SSH ao seu IP público:

```powershell
$MEUIP = (Invoke-RestMethod https://api.ipify.org)
$NSG = az network nsg list -g $RG --query "[0].name" -o tsv
az network nsg rule update -g $RG --nsg-name $NSG -n default-allow-ssh --source-address-prefixes $MEUIP
```

## 6. Preparar a VM

```powershell
ssh azureuser@<IP-PUBLICO>
```

Dentro da VM:

```bash
# Docker Engine + Compose v2 (script oficial)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Saia e entre de novo no SSH para o grupo "docker" valer
exit
```

Reconecte e confirme:

```bash
docker version
docker compose version
```

## 7. Baixar o projeto e configurar

O projeto está na pasta `DockerCode/` dentro do repositório:

```bash
git clone https://github.com/FelipeVandevelde/sistemas_distribuidos.git
cd sistemas_distribuidos/DockerCode
```

> Se o repositório for privado, use um *Personal Access Token* no `git clone` ou envie os arquivos por `scp -r` (exclua `node_modules/` e `dist/`).

### Trocar as credenciais padrão (antes da primeira subida)

O `.env` não é versionado. Crie-o com senhas fortes **antes do primeiro `up`**:

```bash
cat > .env <<EOF
POSTGRES_DB=dockercode
POSTGRES_USER=dockercode
POSTGRES_PASSWORD=$(openssl rand -hex 16)
RABBITMQ_USER=dockercode
RABBITMQ_PASSWORD=$(openssl rand -hex 16)
EOF
```

> [!WARNING]
> O PostgreSQL e o RabbitMQ gravam a senha no volume na **primeira** inicialização. Se trocar a senha depois, é preciso recriar os volumes (`docker compose down -v`, o que apaga os dados).

## 8. Subir o sistema

```bash
docker compose up -d --build
```

A primeira subida é demorada: além dos serviços .NET e do front-end, o `sandbox-builder` baixa/constrói as 4 imagens de sandbox. Acompanhe:

```bash
docker compose ps -a
docker compose logs -f sandbox-builder worker-1
```

Pronto quando: `sandbox-builder` está `Exited (0)` e os demais `Up`/`healthy`.

Acesse no navegador: `http://<IP-PUBLICO>:8080`

## 9. Validar

Da **sua máquina** (Node.js 20+), apontando para a nuvem:

```powershell
$env:DOCKERCODE_URL = "http://<IP-PUBLICO>:8080"
node scripts/smoke-test.mjs
```

Esperado: `Todos os smoke tests passaram.` (8 testes: Python com stdin, JavaScript, Java, C++, erros de compilação Java/C++, runtime error e timeout).

Painel do RabbitMQ sem abrir a porta (túnel SSH):

```powershell
ssh -L 15672:localhost:15672 azureuser@<IP-PUBLICO>
# depois abra http://localhost:15672
```

Health checks (dentro da VM):

```bash
curl -fsS http://localhost:8081/health   # Submission API (porta publicada só no host; bloqueada no NSG)
```

## 10. Operação

| Tarefa | Comando |
|---|---|
| Ver logs de um serviço | `docker compose logs -f worker-1` |
| Atualizar após `git pull` | `docker compose up -d --build` |
| Parar mantendo dados | `docker compose down` |
| Parar e apagar dados | `docker compose down -v` |
| Subir sozinho após reboot da VM | os serviços têm `restart: unless-stopped`; o Docker sobe com a VM |

### Controle de custo

```powershell
az vm deallocate -g $RG -n $VM   # para de cobrar computação (disco continua cobrando)
az vm start      -g $RG -n $VM   # IP público dinâmico pode mudar ao religar
```

Para remover **tudo** quando terminar o trabalho:

```powershell
az group delete --name $RG --yes --no-wait
```

## 11. Hardening recomendado (opcional)

- **HTTPS**: coloque um proxy TLS na frente (por exemplo Caddy/Nginx com Let's Encrypt em um domínio apontando para o IP) ou use Azure Application Gateway. O compose atual serve apenas HTTP na porta 8080.
- **IP fixo**: reserve o IP público como estático para não mudar após `deallocate`.
- **Ambiente**: o compose define `ASPNETCORE_ENVIRONMENT=Development`; para produção real, troque para `Production`.
- **Isolamento**: o sandbox já roda sem rede, sem capabilities, rootfs read-only e limites de CPU/memória/PIDs, mas compartilha o kernel da VM; para código de terceiros não confiáveis considere gVisor/Kata.

## 12. Serviços gerenciados (variante avançada, não validada)

| Componente | Opção no Azure | Observação |
|---|---|---|
| PostgreSQL | Azure Database for PostgreSQL – Flexible Server | Setar `ConnectionStrings__Postgres` do `result-service` com `SSL Mode=Require;Trust Server Certificate=true` e remover o serviço `postgres` e o `depends_on` dele do compose. O Result Service cria a tabela sozinho |
| RabbitMQ | **sem serviço gerenciado compatível** | Azure Service Bus usa AMQP 1.0 e **não** é compatível com `RabbitMQ.Client`. Mantenha o RabbitMQ no compose ou use um provedor externo (ex.: CloudAMQP via Marketplace) |

## 13. Problemas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
| Página não abre | porta 8080 fechada no NSG | `az vm open-port ... --port 8080` |
| Jobs terminam em `INFRA_ERROR` | Worker sem acesso ao Docker ou imagens de sandbox ausentes | `docker compose logs worker-1`; conferir `sandbox-builder` `Exited (0)` |
| `sandbox-builder` falha | sem espaço em disco / sem saída para a internet | `df -h`, aumentar o disco do SO |
| `permission denied` no docker | usuário fora do grupo `docker` | `sudo usermod -aG docker $USER` e reconectar |
| Falha de autenticação no Postgres/RabbitMQ após mudar o `.env` | senha gravada no volume antigo | `docker compose down -v` e subir de novo |
| Front carrega mas `Run` falha | API fora do ar | `docker compose ps`, `docker compose logs submission-api-1 result-service` |
