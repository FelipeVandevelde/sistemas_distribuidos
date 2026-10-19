# Terraform — Deploy na AWS

Provisiona uma **instância EC2 Ubuntu 24.04** na AWS que baixa o projeto e sobe todo o sistema com `docker compose` (mesma arquitetura de [docs/DEPLOY-AWS.md](../../docs/DEPLOY-AWS.md), agora automatizada).

> [!IMPORTANT]
> O código passa em `terraform init -backend=false` e `terraform validate`, mas **nunca foi aplicado (`apply`) em uma conta real**. Faça um `terraform plan` e revise antes do primeiro `apply`.

## 1. O que é criado

| Recurso | Nome | Observação |
|---|---|---|
| `data.aws_ssm_parameter` | AMI Ubuntu 24.04 | AMI mais recente publicada pela Canonical (parâmetro público do SSM) |
| `data.aws_vpc` | VPC padrão | a instância usa a VPC e a sub-rede padrão da região |
| `aws_key_pair` | `<name_prefix>` | a partir de `ssh_public_key_path` |
| `aws_security_group` | `<name_prefix>` | entrada só **22** (`ssh_allowed_cidr`) e **8080** (`app_allowed_cidr`); 8081 e 15672 ficam bloqueadas; saída liberada |
| `aws_instance` | `<name_prefix>` | `t3.large`, disco **gp3 30 GiB criptografado**, **IMDSv2 obrigatório**, `user_data` = cloud-init |
| `aws_eip` (opcional) | `<name_prefix>` | `use_elastic_ip = true` mantém o IP após stop/start |

### O que o cloud-init faz na instância

Arquivo: [`cloud-init.yaml.tftpl`](cloud-init.yaml.tftpl). Executa uma única vez (marcador `/var/lib/dockercode-bootstrap.done`), com log em `/var/log/dockercode-bootstrap.log`:

1. instala Docker Engine + Compose v2 (`get.docker.com`);
2. adiciona o usuário admin ao grupo `docker`;
3. `git clone --depth 1 --branch <repo_ref> <repo_url>` em `/opt/sistemas_distribuidos`;
4. gera o `.env` **na própria instância** com senhas aleatórias (`openssl rand`) — as senhas **não passam pelo Terraform nem pelo state**;
5. `docker compose up -d --build` (inclui o `sandbox-builder`, que constrói as 4 imagens).

## 2. Pré-requisitos

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5 e [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configurado (`aws configure`; teste com `aws sts get-caller-identity`).
- Permissões IAM para EC2 (instâncias, key pairs, security groups, EIP) e `ssm:GetParameter` (parâmetro público da AMI).
- Chave SSH (`ssh-keygen -t ed25519` se não tiver; ajuste `ssh_public_key_path`).
- **Código publicado no Git**: a instância clona o repositório. Faça `git push` do estado atual **antes do `apply`** — em especial as correções do `ExecutionWorker` (workspace em volume tmpfs); sem elas todos os Jobs terminam em `INFRA_ERROR`.
- **Repositório acessível pela instância**: se for privado, o `git clone` anônimo falha. Opções: tornar público durante o deploy, ou usar `repo_url = "https://<usuario>:<token>@github.com/<org>/<repo>.git"` com um token de **leitura somente** (fine-grained PAT). O token ficará no `user_data` da instância e no state; revogue-o depois.
- Cotas: conta nova pode ter limite de vCPU para instâncias On-Demand; se o `apply` falhar com `VcpuLimitExceeded`, solicite aumento ou use outro tipo.

## 3. Variáveis

| Variável | Padrão | Descrição |
|---|---|---|
| `ssh_allowed_cidr` | **obrigatória** | seu IP em CIDR (ex.: `200.100.50.25/32`); `0.0.0.0/0` é rejeitado por validação |
| `region` | `sa-east-1` | região |
| `name_prefix` | `dockercode` | prefixo dos nomes |
| `instance_type` | `t3.large` | 2 vCPU / 8 GiB (mínimo funcional: 4 GiB de RAM) |
| `root_volume_size_gb` | `30` | disco gp3 (o padrão de 8 GiB **não** basta) |
| `admin_username` | `ubuntu` | usuário padrão da AMI |
| `ssh_public_key_path` | `~/.ssh/id_rsa.pub` | chave pública |
| `app_allowed_cidr` | `0.0.0.0/0` | quem acessa o front-end (8080) |
| `use_elastic_ip` | `true` | associa Elastic IP |
| `repo_url` | `https://github.com/FelipeVandevelde/sistemas_distribuidos.git` | repositório Git |
| `repo_ref` | `main` | branch/tag |
| `project_subdir` | `DockerCode` | pasta com o `docker-compose.yml` |
| `tags` | `{ project = "dockercode" }` | tags (via `default_tags`) |

## 4. Outputs

| Output | Conteúdo |
|---|---|
| `public_ip` | IP público (Elastic IP, se habilitado) |
| `app_url` | `http://<ip>:8080` |
| `ssh_command` | `ssh -i ~/.ssh/id_rsa <usuario>@<ip>` (ajuste a chave privada) |
| `bootstrap_log_command` | `tail -f` do log do bootstrap |
| `instance_id` | ID da instância |

## 5. Passo a passo

```powershell
aws configure                               # credenciais e região
cd terraform/aws
Copy-Item terraform.tfvars.example terraform.tfvars   # edite ssh_allowed_cidr (seu IP) etc.

terraform init
terraform plan -out tfplan
terraform apply tfplan
```

O `apply` termina em ~1–2 min, mas **o sistema só fica pronto depois do bootstrap** (primeira subida: vários minutos, por causa do `build` .NET/front-end e das 4 imagens de sandbox). Acompanhe:

```powershell
terraform output -raw bootstrap_log_command | Invoke-Expression
```

Pronto quando o log terminar sem erro. Valide da sua máquina:

```powershell
$env:DOCKERCODE_URL = (terraform output -raw app_url)
node ../../scripts/smoke-test.mjs
```

Esperado: `Todos os smoke tests passaram.`

## 6. Atualizar o sistema

O bootstrap roda **uma vez**. Para publicar uma nova versão, escolha:

- **Sem recriar a instância** (mantém dados): `ssh` na instância e
  ```bash
  cd /opt/sistemas_distribuidos && sudo git pull && cd DockerCode && sudo docker compose up -d --build
  ```
- **Recriar a instância do zero** (perde os dados do Postgres/RabbitMQ): `terraform apply -replace=aws_instance.this`.

> [!NOTE]
> Como `user_data_replace_on_change = true`, alterar `repo_url`/`repo_ref`/`project_subdir`/`admin_username` **recria a instância** no próximo `apply`.

## 7. Destruir (parar de pagar)

```powershell
terraform destroy
```

Remove a instância, o Security Group, o key pair e o Elastic IP.

## 8. Estado do Terraform

Por padrão o state fica **local** (`terraform.tfstate`, ignorado pelo Git). Ele contém o IP e o `user_data` (e o token, se você o colocou em `repo_url`) — não o versione. Para trabalho em equipe, configure um backend remoto (`s3` com bucket versionado e tabela/lockfile) em `versions.tf`.

## 9. Limitações e decisões

- **Instância única, sem alta disponibilidade**: o Worker precisa do Docker socket, o que impede Fargate/App Runner sem reescrever o Worker.
- **VPC e sub-rede padrão**: simples, mas a instância fica em sub-rede pública. Para um ambiente mais rígido, crie VPC própria.
- **Somente HTTP** na porta 8080. Para HTTPS adicione um proxy TLS ou ALB com certificado do ACM (fora deste módulo).
- **PostgreSQL e RabbitMQ dentro da instância** (compose). RDS/Amazon MQ exigem alterações no compose e, para o Amazon MQ, TLS (porta 5671), que o código atual não habilita.
- `t3.large` é *burstable*; para carga contínua use `m6i.large`/`c6i.large`.
- O compose mantém `ASPNETCORE_ENVIRONMENT=Development`.
- O Elastic IP é cobrado quando fica sem uso; a AWS também cobra IPv4 público em uso.

## 10. Problemas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
| `VcpuLimitExceeded` / `InstanceLimitExceeded` | cota da conta | solicitar aumento ou trocar `instance_type` |
| `InvalidKeyPair.Duplicate` | key pair com o mesmo nome já existe na região | mudar `name_prefix` ou remover o key pair antigo |
| `app_url` não abre logo após o apply | bootstrap ainda em andamento | acompanhar o log (seção 5) |
| Log: `Repository not found` / `Authentication failed` | repositório privado | ver pré-requisitos (token ou repo público) |
| `no space left on device` | disco muito pequeno | aumentar `root_volume_size_gb` |
| Jobs terminam em `INFRA_ERROR` | o `main` do Git não tem as correções do Worker | `git push` das correções e atualizar a instância (seção 6) |
| Não consigo dar SSH | seu IP mudou | atualizar `ssh_allowed_cidr` e `terraform apply` |
