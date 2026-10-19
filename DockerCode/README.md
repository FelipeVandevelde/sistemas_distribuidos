# DockerCode — Sandbox Distribuído de Execução de Código

## Sobre o projeto

DockerCode é um projeto acadêmico de Sistemas Distribuídos para submissão e execução isolada de código. O front-end React/Vite mantém o Monaco Editor e o design original; o back-end foi dividido em **Submission API**, **Result Service** e **Execution Worker**, todos em **C#/.NET 8**.

Nesta versão, o fluxo local funcional é:

```text
React / Monaco Editor
        ↓ HTTP
Nginx
        ↓ balanceamento
Submission API (2 réplicas)
        ↓ REST                  ↓ AMQP
Result Service ───────────→ RabbitMQ
        ↓ SQL                   ↓
PostgreSQL                Workers (2 réplicas)
                               ↓ Docker Engine
                         Sandbox efêmero
                               ↓
                    Python / Node / Java / C++
```

Linguagens suportadas nesta entrega:

- `python` → Python 3.12
- `javascript` → Node.js 22
- `java` → Java 21
- `cpp` → GCC/G++ 14

> Decisão desta etapa: foram mantidas as quatro linguagens já existentes no front-end. A versão mínima original do documento de arquitetura citava Python e C#, mas esta implementação segue a decisão posterior do projeto de suportar Python, JavaScript, Java e C++.

## Arquitetura

### Front-end / Nginx

O front-end usa React, Vite e Monaco Editor. Em Docker, um Nginx serve o build estático e encaminha `/api` para duas réplicas da Submission API. Os caminhos de imagem existentes no JSX foram preservados; o build copia a pasta `img/` para `dist/img/`.

### Submission API

Responsável por:

- validar linguagem, tamanho do código e tamanho do stdin;
- solicitar a criação do Job ao Result Service;
- publicar o Job no RabbitMQ;
- permitir consulta de estado por `GET /api/jobs/{id}`;
- expor `/health`.

### Result Service

É o dono do estado persistente dos Jobs. Usa PostgreSQL para armazenar:

- Job ID;
- linguagem;
- código-fonte;
- stdin;
- status;
- stdout/stderr;
- exit code;
- failure reason;
- timestamps;
- Worker ID;
- lease e lease token;
- Correlation ID.

Estados implementados:

```text
QUEUED
RUNNING
SUCCEEDED
FAILED
TIMEOUT
```

### RabbitMQ

A fila `execution.jobs` distribui Jobs entre Workers concorrentes. As mensagens são persistentes e usam `ack` manual. O Worker confirma a mensagem somente depois que o resultado final é aceito pelo Result Service.

### Execution Worker

Cada Worker:

1. consome um Job do RabbitMQ;
2. tenta obter claim/lease no Result Service;
3. cria um volume tmpfs efêmero para o `/workspace` e um container Docker efêmero que o monta;
4. envia somente o código da aba ativa e o stdin ao `/workspace` (via API de archive do Docker);
5. compila/executa conforme a linguagem;
6. captura stdout, stderr e exit code;
7. classifica sucesso, erro de compilação, erro de runtime, timeout ou limite de memória;
8. persiste o resultado;
9. remove o container e o volume;
10. confirma a mensagem do RabbitMQ.

### Sandboxes Docker

As imagens ficam em:

```text
sandbox-images/
├── python/
├── javascript/
├── java/
└── cpp/
```

O serviço temporário `sandbox-builder` do Compose apenas constrói essas imagens e encerra. As sandboxes **não ficam permanentemente executando**: o Worker cria um container novo por tentativa e o remove ao final.

Controles mínimos aplicados a cada execução:

- usuário `10001:10001` não-root;
- `network none`;
- root filesystem read-only;
- `/workspace` em volume Docker efêmero com driver tmpfs (em memória, 32 MiB, `exec` habilitado para o binário C++), criado por Job e removido ao final; `/tmp` em tmpfs;
- remoção de todas as Linux capabilities;
- `no-new-privileges`;
- limite de memória: 256 MiB;
- limite de CPU: 1 CPU;
- limite de processos: 64 PIDs;
- timeout padrão: 10 segundos;
- limite de logs do container e truncamento de stdout/stderr no Worker;
- remoção forçada do container ao final.

A Submission API e o Result Service **não recebem o Docker socket**. Somente os Workers e o construtor temporário de imagens acessam `/var/run/docker.sock`.

## Pré-requisitos

Para executar a aplicação completa:

- Docker Engine ou Docker Desktop;
- Docker Compose v2;
- execução de **Linux containers**.

Para desenvolvimento individual:

- Node.js 20+ (22 recomendado);
- npm;
- .NET 8 SDK;
- Docker para o Worker/sandboxes.

## Como executar tudo

Na raiz do projeto:

```bash
docker compose build
docker compose up
```

Abra:

```text
http://localhost:8080
```

RabbitMQ Management:

```text
http://localhost:15672
```

Credenciais padrão locais:

```text
usuário: dockercode
senha:   dockercode
```

A primeira subida pode demorar mais porque as quatro imagens de sandbox serão construídas. Nas próximas execuções o cache do Docker reduz esse tempo.

## Como parar

```bash
docker compose down
```

Para também remover os dados locais do PostgreSQL e RabbitMQ:

```bash
docker compose down -v
```

## Como reconstruir

```bash
docker compose build --no-cache
docker compose up
```

Se a alteração foi somente no código e você quiser preservar cache:

```bash
docker compose up --build
```

## Desenvolvimento do front-end com Vite

1. Suba a infraestrutura/back-end com Docker Compose.
2. Na raiz do projeto:

```bash
npm install
npm run dev
```

Abra:

```text
http://localhost:5173
```

Por padrão, o Vite encaminha `/api` para:

```text
http://localhost:8081
```

É possível alterar isso com:

```text
VITE_DEV_API_PROXY_TARGET
```

Ou definir uma base HTTP explícita para o navegador:

```text
VITE_API_BASE_URL
```

Veja `.env.example`.

## Contrato HTTP principal

### Criar Job

```http
POST /api/jobs
Content-Type: application/json
```

Exemplo:

```json
{
  "language": "python",
  "sourceCode": "print('teste')",
  "stdin": ""
}
```

Resposta esperada:

```json
{
  "jobId": "...",
  "status": "QUEUED"
}
```

### Consultar Job

```http
GET /api/jobs/{jobId}
```

Exemplo de resposta final:

```json
{
  "jobId": "...",
  "status": "SUCCEEDED",
  "stdout": "Hello, World!\n",
  "stderr": "",
  "exitCode": 0,
  "failureReason": null
}
```

O front-end usa polling simples até o Job chegar a `SUCCEEDED`, `FAILED` ou `TIMEOUT`. O acompanhamento é cancelado se o componente for desmontado ou uma execução anterior for substituída.

## Como testar cada linguagem

### Python

```python
print("Hello, World!")
```

### Python com stdin

Código:

```python
nome = input()
print("Olá,", nome)
```

Na aba **I/O**, antes de clicar em Run:

```text
João
```

### JavaScript

```javascript
console.log("Hello, World!");
```

### Java

```java
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
```

### C++

```cpp
#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
```

### Teste de erro de compilação Java

```java
public class Main {
    public static void main(String[] args) {
        System.out.println("faltou fechar"
    }
}
```

O Console deve mostrar `FAILED`, `COMPILE_ERROR` e o stderr produzido pelo `javac`.

### Teste de erro de compilação C++

```cpp
#include <iostream>
int main() {
    std::cout << "erro" << std::endl
    return 0;
}
```

### Teste de runtime error Python

```python
raise RuntimeError("falha de teste")
```

### Teste de timeout Python

```python
while True:
    pass
```

Após aproximadamente 10 segundos, o Job deve terminar como `TIMEOUT`.

### Smoke test automatizado do backend

Depois de `docker compose up`, em outro terminal execute:

```bash
node scripts/smoke-test.mjs
```

O script cobre as quatro linguagens, stdin, erros de compilação Java/C++, runtime error e timeout.

## Limitações atuais

- Somente **a aba ativa** do Monaco é enviada ao backend e executada.
- As outras abas continuam existindo apenas como conveniência do editor; esta versão não é um sistema de projetos multifile.
- A linguagem é armazenada por aba no front-end. Ao selecionar outra aba, o seletor volta para a linguagem associada a ela.
- `stdin` deve ser informado integralmente **antes** de clicar em Run.
- Não existe terminal interativo, WebSocket ou SignalR.
- Cada tentativa usa um container efêmero.
- A rede externa é bloqueada dentro do sandbox.
- Não há instalação dinâmica de pacotes/bibliotecas durante a execução.
- O timeout padrão é de 10 segundos.
- O lease/heartbeat é propositalmente simples: suficiente para impedir que uma tentativa antiga sobrescreva um resultado novo e para permitir novo claim após expiração.
- Não há AKS, Kubernetes, KEDA, Azure, Terraform, autenticação ou observabilidade avançada nesta etapa.

## Botões do front-end

- **Run**: envia código da aba ativa + linguagem + stdin para a API, recebe o Job ID e acompanha por polling.
- **Lixeira**: limpa o conteúdo mostrado no Console.
- **Rotação/reset**: restaura o código inicial da linguagem associada à aba ativa.

## Tratamento de erros

O Console pode apresentar, conforme o caso:

- validação de linguagem/código/stdin;
- API indisponível;
- Result Service indisponível;
- RabbitMQ indisponível;
- Docker indisponível;
- `COMPILE_ERROR`;
- `RUNTIME_ERROR`;
- `MEMORY_LIMIT`;
- `TIMEOUT`;
- `INFRA_ERROR`;
- stderr do compilador/runtime;
- exit code quando aplicável.

Stack traces internos dos serviços não são enviados diretamente ao navegador.

## Health checks

Endpoints disponíveis:

```text
Submission API: /health
Result Service: /health
Execution Worker: /health
```

O PostgreSQL e RabbitMQ também possuem health checks no Docker Compose.

## Estrutura das pastas

```text
DockerCode/
├── src/                         # front-end React existente
│   ├── components/
│   └── services/api.js
├── img/                         # imagens originais preservadas
├── services/
│   ├── SubmissionApi/
│   ├── ResultService/
│   └── ExecutionWorker/
├── sandbox-images/
│   ├── python/
│   ├── javascript/
│   ├── java/
│   └── cpp/
├── infra/nginx/
├── scripts/
├── Dockerfile                  # build do front-end + Nginx
├── docker-compose.yml
├── DockerCode.sln
├── .env.example
├── .gitignore
├── .dockerignore
└── README.md
```

## Deploy em nuvem

Roteiros para publicar o mesmo `docker-compose.yml` em uma VM Linux (o Worker precisa do Docker socket, então Container Apps/Fargate/AKS/EKS não servem sem reescrever o Worker):

- [Azure](docs/DEPLOY-AZURE.md)
- [AWS](docs/DEPLOY-AWS.md)

Os mesmos deploys automatizados com Terraform (VM + cloud-init + `docker compose up`):

- [Terraform — Azure](terraform/azure/README.md)
- [Terraform — AWS](terraform/aws/README.md)

## Evoluções futuras

Depois do fluxo local estar estável, o projeto pode evoluir conforme o trabalho acadêmico exigir, incluindo Terraform/Azure, testes de carga, roteiro formal de falha e refinamentos de observabilidade. AKS/Kubernetes, tracing avançado, gVisor/Firecracker e terminal interativo permanecem fora desta entrega.
