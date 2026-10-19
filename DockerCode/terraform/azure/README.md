# Terraform — Deploy no Azure

Provisiona uma **VM Ubuntu 22.04** no Azure que baixa o projeto e sobe todo o sistema com `docker compose` (mesma arquitetura de [docs/DEPLOY-AZURE.md](../../docs/DEPLOY-AZURE.md), agora automatizada).

> [!IMPORTANT]
> O código passa em `terraform init -backend=false` e `terraform validate`, mas **nunca foi aplicado (`apply`) em uma assinatura real**. Faça um `terraform plan` e revise antes do primeiro `apply`.

## 1. O que é criado

| Recurso | Nome | Observação |
|---|---|---|
| `azurerm_resource_group` | `rg-<name_prefix>` | contém tudo; `destroy` remove o conjunto |
| `azurerm_virtual_network` / `azurerm_subnet` | `vnet-…` / `snet-…` | `10.20.0.0/16` / `10.20.1.0/24` |
| `azurerm_public_ip` | `pip-…` | **Static**, SKU Standard (IP não muda após deallocate) |
| `azurerm_network_security_group` | `nsg-…` | libera só **22** (`ssh_allowed_cidr`) e **8080** (`app_allowed_cidr`); 8081 e 15672 ficam bloqueadas |
| `azurerm_network_interface` + associação com o NSG | `nic-…` | |
| `azurerm_linux_virtual_machine` | `vm-…` | Ubuntu 22.04 LTS gen2, login só por chave SSH, `custom_data` = cloud-init |

### O que o cloud-init faz na VM

Arquivo: [`cloud-init.yaml.tftpl`](cloud-init.yaml.tftpl). Executa uma única vez (marcador `/var/lib/dockercode-bootstrap.done`), com log em `/var/log/dockercode-bootstrap.log`:

1. instala Docker Engine + Compose v2 (`get.docker.com`);
2. adiciona o usuário admin ao grupo `docker`;
3. `git clone --depth 1 --branch <repo_ref> <repo_url>` em `/opt/sistemas_distribuidos`;
4. gera o `.env` **na própria VM** com senhas aleatórias (`openssl rand`) — as senhas **não passam pelo Terraform nem pelo state**;
5. `docker compose up -d --build` (inclui o `sandbox-builder`, que constrói as 4 imagens).

## 2. Pré-requisitos

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5 e [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli).
- Chave SSH (`ssh-keygen -t ed25519` se não tiver; ajuste `ssh_public_key_path`).
- **Código publicado no Git**: a VM clona o repositório. Faça `git push` do estado atual **antes do `apply`** — em especial as correções do `ExecutionWorker` (workspace em volume tmpfs); sem elas todos os Jobs terminam em `INFRA_ERROR`.
- **Repositório acessível pela VM**: se for privado, o `git clone` anônimo falha. Opções: tornar público durante o deploy, ou usar `repo_url = "https://<usuario>:<token>@github.com/<org>/<repo>.git"` com um token de **leitura somente** (fine-grained PAT). O token ficará no `custom_data` da VM e no state; revogue-o depois.
- Disponibilidade da SKU na região: se `vm_size` não existir em `location`, o `plan/apply` falha com `SkuNotAvailable`. Verifique com `az vm list-skus --location <regiao> --size Standard_D2s --output table`.

## 3. Variáveis

| Variável | Padrão | Descrição |
|---|---|---|
| `ssh_allowed_cidr` | **obrigatória** | seu IP em CIDR (ex.: `200.100.50.25/32`); `0.0.0.0/0` é rejeitado por validação |
| `subscription_id` | `null` | se `null`, usa `ARM_SUBSCRIPTION_ID` |
| `name_prefix` | `dockercode` | prefixo dos nomes |
| `location` | `brazilsouth` | região |
| `vm_size` | `Standard_D2s_v5` | 2 vCPU / 8 GiB (mínimo funcional: 4 GiB de RAM) |
| `os_disk_size_gb` | `64` | disco do SO |
| `admin_username` | `azureuser` | usuário da VM |
| `ssh_public_key_path` | `~/.ssh/id_rsa.pub` | chave pública |
| `app_allowed_cidr` | `0.0.0.0/0` | quem acessa o front-end (8080) |
| `repo_url` | `https://github.com/FelipeVandevelde/sistemas_distribuidos.git` | repositório Git |
| `repo_ref` | `main` | branch/tag |
| `project_subdir` | `DockerCode` | pasta com o `docker-compose.yml` |
| `tags` | `{ project = "dockercode" }` | tags |

## 4. Outputs

| Output | Conteúdo |
|---|---|
| `public_ip` | IP público |
| `app_url` | `http://<ip>:8080` |
| `ssh_command` | `ssh <usuario>@<ip>` |
| `bootstrap_log_command` | `tail -f` do log do bootstrap |
| `resource_group_name` | nome do grupo de recursos |

## 5. Passo a passo

```powershell
az login
az account show --query id -o tsv          # copie o ID da assinatura
$env:ARM_SUBSCRIPTION_ID = "<ID>"          # ou use subscription_id no tfvars

cd terraform/azure
Copy-Item terraform.tfvars.example terraform.tfvars   # edite ssh_allowed_cidr (seu IP) etc.

terraform init
terraform plan -out tfplan
terraform apply tfplan
```

O `apply` termina em ~2–3 min, mas **o sistema só fica pronto depois do bootstrap** (primeira subida: vários minutos, por causa do `build` .NET/front-end e das 4 imagens de sandbox). Acompanhe:

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

- **Sem recriar a VM** (mantém dados): `ssh` na VM e
  ```bash
  cd /opt/sistemas_distribuidos && sudo git pull && cd DockerCode && sudo docker compose up -d --build
  ```
- **Recriar a VM do zero** (perde os dados do Postgres/RabbitMQ): `terraform apply -replace=azurerm_linux_virtual_machine.this`.

> [!NOTE]
> Alterar `repo_url`/`repo_ref`/`project_subdir` muda o `custom_data`, o que força a **recriação da VM** no próximo `apply`.

## 7. Destruir (parar de pagar)

```powershell
terraform destroy
```

Remove o grupo de recursos inteiro e todos os dados.

## 8. Estado do Terraform

Por padrão o state fica **local** (`terraform.tfstate`, ignorado pelo Git). Ele contém o IP e o `custom_data` (e o token, se você o colocou em `repo_url`) — não o versione. Para trabalho em equipe, configure um backend remoto (`azurerm` com Storage Account) em `versions.tf`.

## 9. Limitações e decisões

- **VM única, sem alta disponibilidade**: o Worker precisa do Docker socket, o que impede Container Apps/AKS sem reescrever o Worker.
- **Somente HTTP** na porta 8080. Para HTTPS adicione um proxy TLS ou Application Gateway (fora deste módulo).
- **PostgreSQL e RabbitMQ dentro da VM** (compose). Serviços gerenciados exigem alterações no compose e, para RabbitMQ, não há equivalente compatível no Azure.
- O compose mantém `ASPNETCORE_ENVIRONMENT=Development`.
- Disco: `Premium_LRS`. Troque para `StandardSSD_LRS` em `main.tf` para reduzir custo.

## 10. Problemas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
| `SkuNotAvailable` | `vm_size` indisponível na região | trocar `vm_size` ou `location` |
| `subscription_id is a required provider property` | assinatura não informada | `ARM_SUBSCRIPTION_ID` ou `subscription_id` |
| `app_url` não abre logo após o apply | bootstrap ainda em andamento | acompanhar o log (seção 5) |
| Log: `Repository not found` / `Authentication failed` | repositório privado | ver pré-requisitos (token ou repo público) |
| Jobs terminam em `INFRA_ERROR` | o `main` do Git não tem as correções do Worker | `git push` das correções e atualizar a VM (seção 6) |
| Não consigo dar SSH | seu IP mudou | atualizar `ssh_allowed_cidr` e `terraform apply` |
