# Prompt Handoff — Layout UI/UX no Figma AI (`DockerTracer`)

Este documento contém os prompts prontos para copiar e colar em ferramentas de geração de UI por IA no Figma (**Figma First Draft / Figma Make**, **Galileo AI**, **Uizard**, **Relume** ou **v0**), seguidos da especificação de componentes para handoff.

---

## 1. Prompt Principal Completo (Ideal para Figma Make / v0 / Galileo AI)

> **Como usar:** Copie o bloco abaixo e cole diretamente na ferramenta de IA de design. Ele já descreve a divisão exata Esquerda (Topologia com nós fixos + clientes dinâmicos) e Direita (Painel de 2 Abas: Cliente Único vs. Baterias Automatizadas/Caos).

```text
Design a modern desktop web application UI (1440x900px, dark mode tech/observability theme inspired by Cisco Packet Tracer, Datadog, and Docker Desktop) called "DockerTracer — Distributed Sandbox Network Simulator".

OVERALL LAYOUT STRUCTURE (2-COLUMN SPLIT SCREEN):
- Top Header Bar (48px height): App logo "DockerTracer", global infrastructure status pills ("Docker Engine: Online", "RabbitMQ: 0 Queued", "Postgres: Healthy", "Orphan Containers: 0"), and simulation clock.
- Left Main Area (62% width): Interactive Node Topology Canvas (Cisco Packet Tracer style).
- Right Sidebar Panel (38% width): Full-height interactive control & inspection dock with 2 prominent top tabs:
  * Tab 1: "1. Cliente Único (Raio-X)" (Single Client & Under-the-Hood Inspector)
  * Tab 2: "2. Baterias & Carga (Automação/Caos)" (Automated Suites, Load Tests & Fault Injection)

---
LEFT AREA: INFRASTRUCTURE NODE TOPOLOGY CANVAS (62% WIDTH)
A dark dotted-grid canvas showing the distributed architecture of "DockerCode" arranged in logical left-to-right tiers connected by glowing protocol cables (HTTP in cyan, REST in violet, AMQP in orange, SQL in emerald, Unix Socket in gold) with animated packet envelopes (PDUs) and green/amber/red port LEDs:

1. DYNAMIC / EPHEMERAL CLIENT ZONE (Far Left - Nodes that appear and disappear):
   - Show dynamic "Client Request Nodes" (e.g., "Client #01 [Python]", "Client #02 [C++]", "Client #03 [Dropped]") that spawn with a fade-in/pulse animation when sending requests and fade-out/disappear once finished or aborted.
   - Each temporary client card shows a mini status badge (SUBMITTING, POLLING 750ms, 200 OK, or ABORTED).

2. FIXED DOCKERCODE INFRASTRUCTURE NODES (Center to Right - Permanent Nodes):
   - Gateway Tier: "Nginx Load Balancer (:8080)" node with badge "least_conn" and active connection counters.
   - Ingestion Tier: Two stacked nodes "submission-api-1 (:8081)" and "submission-api-2 (:8080)" with "No Docker Socket" shield badges.
   - State & Messaging Tier:
     * "RabbitMQ Broker (:5672)" node showing a visual queue bar for "execution.jobs (Ready / Unacked)".
     * "result-service (:8080)" node connected to a cylindrical database node "PostgreSQL 16 (:5432 - jobs table)".
   - Worker Tier: Two stacked nodes "worker-1" and "worker-2", each showing a "Lease: 20s" progress bar, a pulsing "Heartbeat: 5s" indicator, and "prefetch=1".
   - Isolation Tier (Far Right): "Docker Engine (/var/run/docker.sock)" node connected to ephemeral sandbox slots ("dockercode-sandbox [tmpfs 32MB | 256MB RAM | net:none | ro-rootfs]").

- Bottom Floating Canvas HUD: Zoom controls, protocol cable legend (HTTP, REST, AMQP, SQL, Docker Socket), and a quick node/packet summary bar.

---
RIGHT PANEL — STATE A: TAB 1 ACTIVE ("1. Cliente Único (Raio-X)")
Designed to test a single client request and inspect everything happening under the hood:
1. Single Request Composer Card:
   - Language segmented selector: Python 3.12 | Node.js 22 | Java 21 | C++ 14.
   - Behaviour preset dropdown: "Execução Limpa (Sucesso)", "Erro de Compilação (javac/g++)", "Erro de Runtime", "Estouro de Memória (OOM 256MB)", "Loop Infinito (Timeout 10s)".
   - Compact code preview + Stdin input field + primary button "▶ Disparar Cliente Único".
2. Packet Tracer Step Controller:
   - Mode toggle: "Realtime" vs "Step-by-Step (Passo a Passo)".
   - Playback buttons: [⏮ Reset] [⏯ Pause/Play] [⏭ Próximo Passo (Next Hop)] and Speed slider (0.25x to 4x).
3. "Por Baixo dos Panos" (Under-the-Hood Deep Inspector):
   - Live Step Timeline (vertical stepper showing the exact 22-step journey of the single request: HTTP POST -> Nginx least_conn -> Submission API validate -> ResultService SQL INSERT QUEUED -> RabbitMQ Publish+Confirm -> Worker Claim + LeaseToken -> Docker Socket Create Volume tmpfs + Container + PutArchive .tar -> Wait/Logs -> Delete Container/Volume -> BasicAck -> Polling GET).
   - Active Packet / Node X-Ray Drawer: Tabs for "Payload JSON / Headers", "PostgreSQL Row (lease_token, attempt_count)", and "Sandbox Security & Output (stdout/stderr, exitCode)".

---
RIGHT PANEL — STATE B: TAB 2 ACTIVE ("2. Baterias & Carga (Automação/Caos)")
Designed to trigger automated multi-client test suites, drop requests, run load tests, and inject infrastructure failures:
1. Automated Test Suites Grid (Action Cards with "Executar Bateria" buttons):
   - "Smoke Test Completo (10 casos)": Runs all 4 languages, stdin, compile error, runtime error, OOM, truncation, and timeout.
   - "Rajada de Concorrência (Burst c=24)": Spawns 24 simultaneous client nodes on the left canvas to stress Nginx least_conn and fill the RabbitMQ queue.
   - "Bateria de Queda de Requisições (Drop/Abort)": Simulates clients cancelling requests mid-polling, invalid >64KB payloads (HTTP 400), and network drops.
   - "Workload Hostil (c=10)": Mixes OOM bombs, infinite loops (10s kill), and valid jobs in parallel.
2. Chaos & Fault Injection Controls (Toggles/Buttons to break things live):
   - "Derrubar Worker-1 em Execução" (demonstrates 20s lease expiration in Postgres and automatic job reclaim by Worker-2 with a new lease_token).
   - "Indisponibilizar RabbitMQ" (demonstrates Submission API marking job as BROKER_UNAVAILABLE and returning HTTP 503).
   - "Cancelar / Derrubar Requisição Ativa" (kills an in-flight client request).
3. Live Load & Telemetry Dashboard:
   - Real-time KPI cards: Active Virtual Clients, Throughput (jobs/s), Success Rate (%), Infrastructure Errors.
   - Latency Breakdown Bars (P50 / P95): HTTP Ingestion (ms), RabbitMQ Queue Wait (ms), Docker Sandbox Execution (ms), Total Turnaround (ms).
   - Resource Cleanup Audit badge: "Containers Órfãos: 0 | Volumes tmpfs Órfãos: 0".
```

---

## 2. Prompt Curto (Para Plugins Figma com Limite de Caracteres, ex: Figma First Draft)

> **Como usar:** Caso o plugin do Figma tenha limite de ~600–800 caracteres, use esta versão condensada:

```text
Desktop dark-mode observability & network simulator app (1440x900) inspired by Cisco Packet Tracer for "DockerCode".
2-column layout:
LEFT (62%): Interactive Node Topology Canvas. Far left has ephemeral Client nodes that spawn when sending requests and disappear when done. Center/right has fixed infrastructure nodes connected by colored protocol links (HTTP, AMQP, SQL, Unix Socket): Nginx Load Balancer, Submission API 1 & 2, RabbitMQ Queue, Result Service, PostgreSQL, Worker 1 & 2 (with 20s Lease & 5s Heartbeat badges), and Docker Engine spawning isolated Sandboxes.
RIGHT (38%): Control panel with 2 tabs:
Tab 1 "Cliente Único (Raio-X)": Single request launcher (Python/JS/Java/C++), Step-by-Step packet playback controls, protocol hop timeline, and JSON/SQL/Sandbox under-the-hood inspector.
Tab 2 "Baterias & Carga": Automated test suites (Smoke Test, Burst 24x Clients, Request Drop/Abort, Hostile Workload), Chaos Fault Injection toggles (Kill Worker, Drop RabbitMQ), and P50/P95 latency telemetry.
```

---

## 3. Prompts Específicos por Frame (Caso queira gerar 2 telas separadas no Figma)

Se você quiser gerar **dois frames lado a lado no Figma** (um mostrando a **Aba 1 ativa** e outro mostrando a **Aba 2 ativa**):

### Frame 1 — Foco na Aba 1 (Cliente Único + Raio-X por Baixo dos Panos)
```text
Desktop UI (1440x900, dark slate/cyber theme). Left side (62%): Cisco Packet Tracer style node graph showing 1 active temporary Client Node on the far left sending an animated HTTP packet into fixed DockerCode infrastructure nodes (Nginx -> Submission API 1 & 2 -> Result Service -> PostgreSQL -> RabbitMQ -> Worker 1 & 2 -> Docker Engine Socket -> Ephemeral Python Sandbox). Right side (38%): Sidebar with 2 tabs, Tab 1 "Cliente Único (Raio-X)" is ACTIVE. Inside Tab 1: Language picker (Python/JS/Java/C++), Scenario selector, "Send Request" button, Step-by-Step Packet Tracer controls (Play, Pause, Next Step, Speed), a vertical 22-step "Under the Hood" protocol trace list highlighting the current hop, and a bottom JSON/SQL/Docker Container inspector card showing lease_token, tmpfs volume, and stdout.
```

### Frame 2 — Foco na Aba 2 (Baterias Automatizadas, Queda de Requisição e Carga)
```text
Desktop UI (1440x900, dark slate/cyber theme). Left side (62%): Cisco Packet Tracer style node graph under heavy load: 8 dynamic temporary Client Nodes spawning on the far left (some green SUCCEEDED, some blue RUNNING, some red DROPPED/ABORTED), multiple animated packets flowing through Nginx into Submission APIs, RabbitMQ queue bar partially filled with queued messages, Worker-1 marked with a red "CRASHED" badge while Worker-2 reclaims its job lease. Right side (38%): Sidebar with 2 tabs, Tab 2 "Baterias & Carga" is ACTIVE. Inside Tab 2: Automated Test Battery cards (Burst Load c=24, Drop/Cancel Requests, Smoke Suite, Hostile OOM/Timeout Mix), Chaos Engineering switches (Kill Worker-1 to test 20s Lease Expiry, Disconnect RabbitMQ for HTTP 503), and a live telemetry table showing P50/P95 latencies for Ingest, Queue, and Sandbox plus "0 Orphan Containers".
```

---

## 4. Guia de Especificação Visual (Tokens e Componentes para o Layout)

Para garantir consistência entre o design no Figma e a futura implementação em `npm run dev`:

### 4.1. Paleta de Cores (Dark Observability Theme)
| Elemento | Cor / Token | Hex Sugerido | Uso no Layout |
| :--- | :--- | :--- | :--- |
| **Canvas Background** | `bg-canvas` | `#0B0F19` | Fundo do mapa de nós à esquerda com grid pontilhado `#1E293B` |
| **Sidebar / Card Surface** | `bg-panel` | `#111827` / `#1E293B` | Painel lateral direito, cards de nós fixos e inspetores |
| **Enlace HTTP / Cliente** | `link-http` | `#38BDF8` (Cyan) | Cabos e pacotes entre Clientes Efêmeros $\leftrightarrow$ Nginx $\leftrightarrow$ APIs |
| **Enlace REST Interno** | `link-rest` | `#818CF8` (Indigo) | Cabos entre APIs $\leftrightarrow$ Result Service $\leftrightarrow$ Workers |
| **Enlace AMQP (RabbitMQ)** | `link-amqp` | `#FB923C` (Orange) | Cabos e pacotes de fila (`Publish`, `Deliver`, `BasicAck`, `BasicNack`) |
| **Enlace SQL (PostgreSQL)** | `link-sql` | `#34D399` (Emerald) | Cabos e transações `INSERT`/`UPDATE` entre Result Service $\leftrightarrow$ Postgres |
| **Enlace Docker Socket** | `link-docker` | `#FACC15` (Amber/Gold) | Comunicação Unix Socket `/var/run/docker.sock` dos Workers |
| **Status: Sucesso / Saudável** | `status-ok` | `#22C55E` (Green) | LEDs de porta ativos, `SUCCEEDED`, `Healthy` |
| **Status: Em Trânsito / Lease** | `status-warn` | `#F59E0B` (Amber) | `QUEUED`, `RUNNING`, renovação de Heartbeat |
| **Status: Queda / Falha / OOM** | `status-err` | `#EF4444` (Red) | Requisição derrubada, `FAILED`, `TIMEOUT`, Worker abatido, `network: none` |

### 4.2. Diferenciação Visual entre Nós Fixos e Nós Efêmeros (Regra #2)
- **Nós Fixos da Infraestrutura (`Nginx`, `Submission API 1/2`, `Result Service`, `PostgreSQL`, `RabbitMQ`, `Worker 1/2`, `Docker Engine`):**
  - Borda sólida de `1.5px`, canto arredondado `10px`, cabeçalho fixo com ícone da tecnologia, endereço/porta interna e LEDs de porta permanentes.
  - Nunca desaparecem do canvas (se derrubados na Aba 2, ficam com borda vermelha tracejada e selo `OFFLINE / UNHEALTHY`).
- **Nós Dinâmicos que Aparecem e Somem (`Clientes Simulados` na ponta esquerda + `Sandboxes Efêmeros` na ponta direita):**
  - Borda tracejada animada ou efeito *glow* pulsante, formato mais compacto (estilo *pill card*), tag `EFÊMERO / TTL` e animação de entrada (*spawn*) quando a requisição inicia e saída (*despawn*) após a conclusão ou queda da requisição.
