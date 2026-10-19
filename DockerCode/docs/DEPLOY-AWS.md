# Deploy do DockerCode na AWS

Guia para publicar o sistema completo em uma **instância EC2 Linux** executando o mesmo `docker-compose.yml` usado localmente.

> [!IMPORTANT]
> Este roteiro **não foi executado em uma conta AWS real** durante o desenvolvimento. Os comandos seguem a documentação do AWS CLI e do Docker; ajuste regiões/nomes ao seu ambiente e valide cada etapa. A aplicação em si (compose + smoke test) foi validada localmente — ver [VALIDATION.md](../VALIDATION.md).

## 1. Por que EC2 (e não Fargate / App Runner / Lambda)?

O **Execution Worker** cria um container de sandbox por Job conversando com o Docker Engine pelo socket `/var/run/docker.sock`. Isso exige acesso ao daemon Docker do host:

| Serviço AWS | Serve? | Motivo |
|---|---|---|
| **EC2 + Docker Compose** | ✅ | Acesso total ao Docker Engine; é o que o projeto usa localmente |
| ECS Fargate / App Runner / Lambda | ❌ | Não permitem montar o Docker socket do host |
| ECS com launch type EC2 | ⚠️ | Possível montar `docker.sock`, mas exige reescrever o deploy como task definitions; fora do escopo desta entrega |
| EKS | ⚠️ | Exigiria reescrever o Worker (Jobs do Kubernetes / gVisor); fora do escopo |

> [!WARNING]
> Quem acessa o Docker socket tem, na prática, **root na instância**. Use uma instância dedicada ao projeto e nunca exponha o socket nem as portas internas na internet.

## 2. Arquitetura na nuvem

```text
Internet ──:8080──▶ [ Security Group ] ──▶ EC2 Ubuntu (Docker Compose)
                                             ├─ frontend (Nginx)  :8080
                                             ├─ submission-api-1/2
                                             ├─ result-service ──▶ postgres
                                             ├─ rabbitmq
                                             └─ worker-1/2 ──▶ docker.sock ──▶ sandboxes efêmeros
```

## 3. Pré-requisitos

- Conta AWS com permissão para EC2.
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configurado:

```powershell
aws configure          # Access Key, Secret, região (ex.: sa-east-1) e formato
aws sts get-caller-identity
```

## 4. Dimensionamento

| Item | Recomendado | Observação |
|---|---|---|
| Tipo da instância | `t3.large` (2 vCPU / 8 GiB) | mínimo funcional: 2 vCPU / 4 GiB (`t3.medium`); `t3.micro/small` não comportam Java + PostgreSQL + RabbitMQ + 3 serviços .NET |
| Disco (EBS gp3) | 30 GiB | as 4 imagens de sandbox (`gcc`, `temurin`, `node`, `python`) + imagens .NET ocupam alguns GiB; o padrão de 8 GiB **não** basta |
| Sistema | Ubuntu Server 24.04 LTS | |
| Região | `sa-east-1` (São Paulo) | escolha conforme disponibilidade/custo |

> [!NOTE]
> Instâncias `t3` são *burstable*: execuções de compilação pesadas e seguidas podem esgotar créditos de CPU. Para uso contínuo prefira `m6i.large`/`c6i.large`.

## 5. Criar a infraestrutura

Os comandos usam PowerShell; em bash troque `$VAR = ...` por `VAR=...`.

```powershell
$REGION = "sa-east-1"
$NAME   = "dockercode"

# 1) Par de chaves SSH
aws ec2 create-key-pair --region $REGION --key-name $NAME `
  --query KeyMaterial --output text | Out-File -Encoding ascii "$NAME.pem"
# (em Linux/macOS: chmod 400 dockercode.pem)

# 2) Security Group na VPC padrão
$VPC = aws ec2 describe-vpcs --region $REGION --filters Name=isDefault,Values=true `
  --query "Vpcs[0].VpcId" --output text
$SG = aws ec2 create-security-group --region $REGION --group-name $NAME `
  --description "DockerCode" --vpc-id $VPC --query GroupId --output text

$MEUIP = (Invoke-RestMethod https://api.ipify.org)
aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG `
  --protocol tcp --port 22   --cidr "$MEUIP/32"    # SSH somente do seu IP
aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG `
  --protocol tcp --port 8080 --cidr 0.0.0.0/0      # front-end (Nginx)

# 3) AMI Ubuntu 24.04 mais recente (via parâmetro público do SSM)
$AMI = aws ssm get-parameter --region $REGION `
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id `
  --query Parameter.Value --output text

# 4) Instância com disco de 30 GiB
$INSTANCE = aws ec2 run-instances --region $REGION `
  --image-id $AMI --instance-type t3.large --key-name $NAME `
  --security-group-ids $SG `
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3}" `
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" `
  --query "Instances[0].InstanceId" --output text

aws ec2 wait instance-running --region $REGION --instance-ids $INSTANCE

# 5) IP público
aws ec2 describe-instances --region $REGION --instance-ids $INSTANCE `
  --query "Reservations[0].Instances[0].PublicIpAddress" --output text
```

### Regras de rede (Security Group)

| Porta | Ação | Motivo |
|---|---|---|
| 22 (SSH) | **somente o seu IP** | nunca `0.0.0.0/0` |
| 8080 | liberar | front-end + `/api` via Nginx |
| 8081 | **não liberar** | Submission API direta (só para desenvolvimento) |
| 15672 | **não liberar** | RabbitMQ Management com credencial fraca por padrão |

> [!NOTE]
> O `docker-compose.yml` publica `8081` e `15672` no host, mas elas só ficam acessíveis pela internet se o Security Group permitir. Mantenha-as fechadas; para ver o painel do RabbitMQ use um túnel SSH (seção 9).

## 6. Preparar a instância

```powershell
ssh -i dockercode.pem ubuntu@<IP-PUBLICO>
```

Dentro da instância:

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
ssh -i dockercode.pem -L 15672:localhost:15672 ubuntu@<IP-PUBLICO>
# depois abra http://localhost:15672
```

## 10. Operação

| Tarefa | Comando |
|---|---|
| Ver logs de um serviço | `docker compose logs -f worker-1` |
| Atualizar após `git pull` | `docker compose up -d --build` |
| Parar mantendo dados | `docker compose down` |
| Parar e apagar dados | `docker compose down -v` |
| Subir sozinho após reboot da instância | os serviços têm `restart: unless-stopped`; o Docker sobe com a instância |

### Controle de custo

```powershell
aws ec2 stop-instances  --region $REGION --instance-ids $INSTANCE   # para a computação (EBS continua cobrando)
aws ec2 start-instances --region $REGION --instance-ids $INSTANCE   # o IP público muda ao religar
```

Para remover **tudo** quando terminar o trabalho:

```powershell
aws ec2 terminate-instances --region $REGION --instance-ids $INSTANCE
aws ec2 wait instance-terminated --region $REGION --instance-ids $INSTANCE
aws ec2 delete-security-group --region $REGION --group-id $SG
aws ec2 delete-key-pair --region $REGION --key-name $NAME
Remove-Item dockercode.pem
```

## 11. Hardening recomendado (opcional)

- **IP fixo**: associe um *Elastic IP* para o endereço não mudar após `stop/start` (cobrado se ficar sem uso).
- **HTTPS**: coloque um proxy TLS na frente (Caddy/Nginx com Let's Encrypt em um domínio apontando para o IP) ou use um Application Load Balancer com certificado do ACM. O compose atual serve apenas HTTP na porta 8080.
- **Acesso sem SSH aberto**: use AWS Systems Manager Session Manager (perfil IAM com `AmazonSSMManagedInstanceCore`) e feche a porta 22.
- **IMDSv2**: exija tokens de metadados (`--metadata-options HttpTokens=required` no `run-instances`).
- **Ambiente**: o compose define `ASPNETCORE_ENVIRONMENT=Development`; para produção real, troque para `Production`.
- **Isolamento**: o sandbox já roda sem rede, sem capabilities, rootfs read-only e limites de CPU/memória/PIDs, mas compartilha o kernel da instância; para código de terceiros não confiáveis considere gVisor/Kata.

## 12. Serviços gerenciados (variante avançada, não validada)

| Componente | Opção na AWS | Observação |
|---|---|---|
| PostgreSQL | Amazon RDS for PostgreSQL | Setar `ConnectionStrings__Postgres` do `result-service` com `SSL Mode=Require;Trust Server Certificate=true` e remover o serviço `postgres` e o `depends_on` dele do compose. O Result Service cria a tabela sozinho. Libere a porta 5432 do RDS apenas para o Security Group da EC2 |
| RabbitMQ | Amazon MQ for RabbitMQ | Compatível com AMQP 0-9-1, mas exige **TLS (porta 5671)**. O código atual (`ConnectionFactory` no Submission API e no Worker) **não habilita SSL**; seria necessário configurar `Ssl = new SslOption { Enabled = true, ServerName = host }` e a porta `5671` |

## 13. Problemas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
| Página não abre | porta 8080 fechada no Security Group | `authorize-security-group-ingress ... --port 8080` |
| `Connection timed out` no SSH | seu IP mudou desde a criação da regra | atualizar a regra da porta 22 com o novo IP |
| Jobs terminam em `INFRA_ERROR` | Worker sem acesso ao Docker ou imagens de sandbox ausentes | `docker compose logs worker-1`; conferir `sandbox-builder` `Exited (0)` |
| `sandbox-builder` falha / `no space left on device` | disco de 8 GiB padrão | criar a instância com 30 GiB (seção 5) ou expandir o volume EBS |
| `permission denied` no docker | usuário fora do grupo `docker` | `sudo usermod -aG docker $USER` e reconectar |
| Falha de autenticação no Postgres/RabbitMQ após mudar o `.env` | senha gravada no volume antigo | `docker compose down -v` e subir de novo |
| Front carrega mas `Run` falha | API fora do ar | `docker compose ps`, `docker compose logs submission-api-1 result-service` |
