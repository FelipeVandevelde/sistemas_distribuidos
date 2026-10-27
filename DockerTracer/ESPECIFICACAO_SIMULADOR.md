# Especificação Funcional e Visual — `DockerTracer` (Estilo Cisco Packet Tracer)

Este documento define o comportamento, a anatomia visual, os tipos de pacotes (PDUs), os inspetores de dispositivos e os cenários de simulação que comporão o **DockerTracer**.

---

## 1. Estrutura de Layout (Split-Screen: Topologia à Esquerda + Painel de 2 Abas à Direita)

O layout oficial do **DockerTracer** é dividido em duas grandes regiões:

1. **Esquerda (~62% da tela) — Canvas de Topologia da Infraestrutura:**
   - **Nós Fixos:** Representam permanentemente a infraestrutura do `DockerCode` (`Nginx`, `submission-api-1`, `submission-api-2`, `result-service`, `postgres`, `rabbitmq`, `worker-1`, `worker-2`, `Docker Engine Socket`).
   - **Nós Efêmeros (Aparecem e Somem):**
     - Na extremidade esquerda, **Nós de Clientes Simulados (`Client #1`, `Client #2`, ..., `Client #N`)** surgem dinamicamente ao enviar requisições, exibem o estado do ciclo HTTP/Polling e desaparecem ao concluir ou quando têm a requisição derrubada/cancelada.
     - Na extremidade direita, **Sandboxes Efêmeros (`dockercode-<jobId>`) + Volumes `tmpfs`** surgem quando o Worker aciona a API do Docker e somem após o `DELETE` no bloco `finally`.
2. **Direita (~38% da tela) — Painel de Controle e Inspeção com 2 Abas:**
   - **Aba 1 (`1. Cliente Único / Raio-X`):** Focada em disparar e acompanhar **um único cliente** em detalhes (tempo real ou passo a passo), inspecionando tudo o que ocorre por baixo dos panos (pacotes, headers, linha no PostgreSQL, `lease_token`, `heartbeat` e container).
   - **Aba 2 (`2. Baterias & Carga`):** Focada em ativar **baterias de testes automatizados** que criam múltiplos clientes simultâneos, fazem testes de carga/rajada (*burst*), derrubam requisições em trânsito e injetam falhas nos serviços para demonstrar resiliência.

```text
+------------------------------------------------------------------------------------------------------+
| [Logo] DockerTracer       | Status: Nginx OK | RabbitMQ: 0 fila | PG: OK | Containers Órfãos: 0      |
+------------------------------------------------------------------+-----------------------------------+
|                                                                  | [Aba 1: Cliente] [Aba 2: Baterias]|
|         ESQUERDA: TOPOLOGIA DE NÓS (INFRA DOCKERCODE)            +-----------------------------------+
|                                                                  |                                   |
|  NÓS EFÊMEROS          NÓS FIXOS DA INFRAESTRUTURA               |  DIREITA (ABA 1 - CLIENTE ÚNICO): |
|  (Surgem/Somem)        (Permanentes no Canvas)                   |  - Seletor: Py / JS / Java / C++  |
|                                                                  |  - Perfil: Sucesso / OOM / Timeout|
|  (Client #1) ──HTTP──> [Nginx :8080 (least_conn)]                |  - [▶ Enviar Requisição (1 Cli)]  |
|  (Client #2) ──HTTP──>       /              \                    |  - Modo: ( ) Realtime (o) Passo   |
|  (Client #N)          [sub-api-1]        [sub-api-2]             |    [⏮] [⏯] [⏭ Próximo Passo]     |
|                            \      \    /      /                  |  - Raio-X Por Baixo dos Panos:    |
|                             \  [result-service]                  |    Linha do tempo dos 22 passos   |
|                              \       |        \                  |    + Inspetor JSON / SQL / Docker |
|                        [rabbitmq] [postgres]   \                 |                                   |
|                         /      \                \                |  -------------------------------  |
|                  [worker-1]  [worker-2]──────────+               |  DIREITA (ABA 2 - BATERIAS/CAOS): |
|                       \          /                               |  - [Smoke Test] [Burst 24x Cli]   |
|                  [Docker Engine Socket]                          |  - [Derrubar Requisições/Abort]   |
|                       /          \                               |  - [Workload Hostil (OOM+Loop)]   |
|             (Sandbox Efêmero) (Volume tmpfs)                     |  - Caos: [Matar Worker] [Drop MQ] |
|                                                                  |  - Telemetria P50/P95 & Vazão     |
+------------------------------------------------------------------+-----------------------------------+
```

---

## 2. Zonas e Nós do Canvas de Topologia Lógica

O canvas principal será dividido em **5 Zonas Arquiteturais** claramente delimitadas com legendas de rede e segurança:

### Zona 1 — Camada Cliente (Rede Externa / Host)
- **Nó `Client Browser (React + Monaco)`**:
  - Exibe a linguagem selecionada, o status percebido pelo usuário (`IDLE`, `SUBMITTING`, `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMEOUT`) e um indicador do loop de polling (`750ms`).

### Zona 2 — Gateway & Balanceamento de Carga
- **Nó `Nginx Reverse Proxy (:8080)`**:
  - Exibe o algoritmo configurado (`least_conn`) e o contador de conexões ativas para cada upstream (`submission-api-1` e `submission-api-2`).

### Zona 3 — Camada de Ingestão (Stateless APIs)
- **Nós `submission-api-1 (:8081->8080)` e `submission-api-2 (:8080)`**:
  - Exibem indicadores de validação (`<= 64 KiB code`, `<= 32 KiB stdin`), estado do canal RabbitMQ (`ConfirmSelect`) e contador de requisições atendidas.
  - Possuem selo visual **"Sem Docker Socket"** para destacar o isolamento de privilégios.

### Zona 4 — Camada de Coordenação, Estado e Mensageria
- **Nó `RabbitMQ Broker (:5672 / :15672)`**:
  - Exibe visualmente os slots da fila durável `execution.jobs`, diferenciando mensagens `Ready` (aguardando Worker) e `Unacked` (em processamento por um Worker com `prefetch=1`).
- **Nó `result-service (:8080)`**:
  - Exibe as operações internas (`/internal/jobs`, `/claim`, `/heartbeat`, `/complete`, `/mark-failed`).
- **Nó `PostgreSQL 16 (:5432)`**:
  - Exibe um contador de registros na tabela `jobs` por estado e pisca a cada `INSERT` ou `UPDATE`.

### Zona 5 — Camada de Execução e Isolamento (Docker Host)
- **Nós `worker-1` e `worker-2`**:
  - Exibem o Job atualmente em execução, o `LeaseToken` ativo, uma barra regressiva do `Lease (20s)` que é recarregada a cada pulso de `Heartbeat (5s)` e o passo atual no Docker.
- **Nó `Docker Engine (/var/run/docker.sock)`**:
  - Representa o daemon Docker do host recebendo comandos HTTP sobre Unix Socket.
- **Slots Dinâmicos de `Sandbox Efêmero (dockercode-<jobId>)` + `Volume tmpfs (/workspace)`**:
  - Diferente dos outros nós que são fixos, **os containers de sandbox aparecem dinamicamente no canvas quando o Worker chama `POST /containers/create`**, exibem a compilação/execução em andamento, mostram o cadeado vermelho de `network: none` + `rootfs: read-only` e **são destruídos com animação visual no `DELETE /containers/{id}`**.
  - Inclui também um indicador do `sandbox-builder` (`Completed 0` com as 4 imagens prontas no cache local).

---

## 3. Enlaces (Cabos) e LEDs de Interface

Assim como no Cisco Packet Tracer, cada conexão entre dois nós possui um estilo de cabo e LEDs nas extremidades:

| Tipo de Enlace | Estilo Visual do Cabo | Cor Padrão | Exemplo na Topologia |
| :--- | :--- | :--- | :--- |
| **HTTP Público / Proxy** | Linha sólida contínua | Azul Ciano (`#38bdf8`) | `Browser <-> Nginx <-> Submission API` |
| **REST Interno (Microsserviços)** | Linha sólida fina | Índigo / Violeta (`#818cf8`) | `Submission API <-> Result Service <-> Workers` |
| **AMQP 0-9-1 (Mensageria)** | Linha tracejada rápida | Laranja RabbitMQ (`#fb923c`) | `Submission API -> RabbitMQ <-> Workers` |
| **SQL / TCP (:5432)** | Linha dupla de dados | Esmeralda (`#34d399`) | `Result Service <-> PostgreSQL` |
| **Unix Domain Socket** | Linha pontilhada técnica | Amarelo Ouro (`#facc15`) | `Workers <-> Docker Engine (/var/run/docker.sock)` |
| **Ciclo de Vida Docker (Spawn)** | Feixe de provisionamento | Rosa / Magenta (`#f472b6`) | `Docker Engine -..-> Volume tmpfs & Sandbox` |

**LEDs de Porta (inspirados no Packet Tracer):**
- 🟢 ** Círculo Verde:** Serviço saudável (`/health = Healthy`) e enlace ativo.
- 🟡 **Círculo Âmbar Piscando:** Pacote (PDU) sendo transmitido/recebido naquele instante.
- 🔴 **Triângulo Vermelho:** Serviço derrubado manualmente pelo usuário (injeção de falha) ou bloqueado (`network: none` no sandbox).

---

## 4. Catálogo de Pacotes / Envelopes (PDUs)

Cada evento de comunicação gera um "envelope/pacote" animado que percorre o cabo correspondente. Ao clicar no pacote (na tela ou na lista de eventos), o usuário vê o **PDU Inspector** com os dados reais do protocolo:

| Código PDU | Cor | Origem $\rightarrow$ Destino | Resumo do Conteúdo Inspecionável |
| :--- | :--- | :--- | :--- |
| `HTTP POST` | Azul | `Browser -> Nginx -> SubAPI` | `POST /api/jobs` com `{ language, sourceCode, stdin }` |
| `REST CREATE` | Violeta | `SubAPI -> ResultService` | `POST /internal/jobs` + `CorrelationId` |
| `SQL INSERT` | Verde | `ResultService -> Postgres` | `INSERT INTO jobs (...) VALUES (..., 'QUEUED', 0)` |
| `AMQP PUB` | Laranja | `SubAPI -> RabbitMQ` | `BasicPublish(queue="execution.jobs", persistent=true)` + `Confirm` |
| `HTTP 202` | Azul | `SubAPI -> Nginx -> Browser` | `202 Accepted` `{ jobId, status: "QUEUED" }` + `X-Correlation-ID` |
| `AMQP DELIVER` | Laranja | `RabbitMQ -> Worker` | `BasicDeliver` (`prefetch=1`, `autoAck=false`) |
| `REST CLAIM` | Violeta | `Worker -> ResultService` | `POST /internal/jobs/{id}/claim` (`workerId`, `leaseSeconds=20`) |
| `SQL CLAIM` | Verde | `ResultService -> Postgres` | `UPDATE jobs SET status='RUNNING', lease_token=..., attempt_count=attempt_count+1` |
| `REST HB` | Ciano | `Worker -> ResultService` | `POST /internal/jobs/{id}/heartbeat` (renovação do lease a cada 5s) |
| `SOCK VOL+CREATE` | Amarelo | `Worker -> DockerSock` | `POST /volumes/create (tmpfs 32m, exec)` + `POST /containers/create` |
| `SOCK ARCHIVE` | Amarelo | `Worker -> DockerSock` | `POST /start` + `PUT /archive?path=/workspace` (`main.*`, `stdin.txt`, `.ready`) |
| `SOCK WAIT/LOGS` | Amarelo | `Worker -> DockerSock` | `POST /wait` (timeout 10s), `GET /logs` (demux 8-byte header), `GET /json` (`OOMKilled`) |
| `SOCK CLEANUP` | Rosa | `Worker -> DockerSock` | `DELETE /containers/{id}?force=true&v=true` + `DELETE /volumes/{name}` |
| `REST COMPLETE` | Violeta | `Worker -> ResultService` | `POST /internal/jobs/{id}/complete` validando `workerId` + `leaseToken` |
| `AMQP ACK/NACK` | Laranja | `Worker -> RabbitMQ` | `BasicAck` (remove da fila) ou `BasicNack(requeue=true)` em falha |
| `HTTP POLL` | Azul | `Browser -> Nginx -> SubAPI` | `GET /api/jobs/{id}` retornando status atual ou resultado final |

---

## 5. Inspetores de Dispositivos (Ao Clicar em um Nó)

Quando o usuário clica em qualquer nó da topologia, abre-se o painel **Device Inspector** contextualizado:

1. **Inspeção do `Nginx`:**
   - Mostra a configuração de upstream (`least_conn`), total de requests roteados para `submission-api-1` vs `submission-api-2` e conexões ativas no momento.
2. **Inspeção do `RabbitMQ`:**
   - Mostra o estado da fila `execution.jobs` (`Durable: true`), lista de mensagens na fila (`Ready`), mensagens entregues aguardando confirmação (`Unacked`) e os consumidores `worker-1` e `worker-2` (`Prefetch: 1`).
3. **Inspeção do `PostgreSQL / Result Service`:**
   - Mostra uma tabela em tempo real idêntica à tabela `jobs` do banco:
     `JobId (curto) | Lang | Status | WorkerId | Attempts | LeaseToken | LeaseUntil | FailureReason`.
4. **Inspeção do `Worker (1 ou 2)`:**
   - Mostra o estado de saúde (`DockerReady`, `RabbitReady`), o Job em execução, cronômetro do Heartbeat (5s) e o passo atual do ciclo de vida do container.
   - Inclui botão de **Simular Queda/Crash do Worker** para testar expiração de *lease*.
5. **Inspeção do `Sandbox Efêmero`:**
   - Mostra um "Raio-X de Segurança e Isolamento" com todos os parâmetros reais aplicados pelo `DockerEngineClient.cs`:
     - `User`: `10001:10001 (runner)`
     - `NetworkMode`: `none` (sem acesso externo)
     - `Rootfs`: `Read-Only`
     - `/workspace`: `Volume tmpfs (32 MiB, exec, nosuid, nodev, mode=0700)`
     - `/tmp`: `tmpfs (32 MiB, rw, nosuid, nodev)`
     - `Capabilities`: `DROP ALL` + `no-new-privileges`
     - `Limites cgroups`: `Memory=256 MiB (Swap=256 MiB)`, `CPU=1.0 NanoCPUs`, `PidsLimit=64`, `Timeout=10s`

---

## 6. Cenários Pré-Configurados (Presets para Apresentação)

Para facilitar demonstrações em sala de aula ou banca, o simulador terá um seletor rápido de cenários baseados nos testes reais (`smoke-test.mjs` e `load-test.mjs`):

1. **Cenário 1 — Fluxo Nominal (Happy Path):**
   - Dispara 1 Job (Python, JS, Java ou C++ com `stdin`). Ideal para usar no **Modo Step-by-Step** e explicar cada um dos pacotes da infraestrutura.
2. **Cenário 2 — Concorrência e Fila (4 Jobs Paralelos):**
   - Dispara 4 Jobs simultâneos. Demonstra o Nginx alternando entre `submission-api-1` e `submission-api-2`, 2 Jobs entrando imediatamente em execução no `worker-1` e `worker-2` (`RUNNING`) e 2 Jobs aguardando na fila `execution.jobs` do RabbitMQ (`QUEUED`) devido ao `BasicQos(prefetch=1)`.
3. **Cenário 3 — Rajada / Burst (`Load Test`):**
   - Dispara uma onda de Jobs concorrentes para visualizar o amortecimento da fila no RabbitMQ, a criação/destruição contínua de sandboxes efêmeros e a ausência de containers/volumes órfãos ao final.
4. **Cenário 4 — Falhas de Execução no Sandbox (Proteções):**
   - Sub-opções para demonstrar:
     - **Erro de Compilação (`COMPILE_ERROR`):** `javac` ou `g++` falha, emite `__DOCKERCODE_COMPILE_ERROR__`, container sai com código $\neq 0$.
     - **Erro de Runtime (`RUNTIME_ERROR`):** Exceção em Python/JS.
     - **Limite de Memória (`MEMORY_LIMIT`):** Processo tenta alocar além de `256 MiB`, kernel dispara `OOMKilled (exit 137)` ou runtime lança `MemoryError`.
     - **Timeout de Execução (`TIMEOUT`):** Loop infinito `while True: pass`; ao atingir `10s`, o Worker envia `POST /containers/{id}/kill` e encerra como `TIMEOUT`.
5. **Cenário 5 — Resiliência Distribuída (Crash de Worker & Expiração de Lease):**
   - Um Job inicia no `worker-1` (`attempt_count = 1`, `lease_token = T1`).
   - O `worker-1` sofre uma falha (para de enviar `heartbeat`).
   - O `lease_until` expira e a mensagem volta à fila do RabbitMQ.
   - O `worker-2` consome a mensagem, faz um novo `claim` (`attempt_count = 2`, `lease_token = T2`) e conclui o Job.
   - Se o `worker-1` "zumbi" tentar enviar um `complete` atrasado com `T1`, o `Result Service` rejeita (`409 Conflict`) porque o `lease_token` mudou para `T2`.
6. **Cenário 6 — Queda do RabbitMQ na Submissão (`BROKER_UNAVAILABLE`):**
   - Usuário desativa o nó do RabbitMQ; ao submeter um Job, a `Submission API` grava `QUEUED` no banco, falha no `BasicPublish`, chama `POST /internal/jobs/{id}/mark-failed` (`BROKER_UNAVAILABLE`) e retorna `HTTP 503` ao cliente.
