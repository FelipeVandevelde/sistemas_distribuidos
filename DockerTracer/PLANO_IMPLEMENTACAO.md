# Plano de Arquitetura e Implementação — `DockerTracer` (`npm run dev`)

Este documento descreve como a aplicação **DockerTracer** será construída na pasta `dockertracer/` quando iniciarmos a etapa de codificação.

---

## 1. Stack Tecnológica Planejada

Para manter total alinhamento com o ecossistema já utilizado no `DockerCode` e garantir execução imediata via `npm run dev`:

- **Build Tool & Dev Server:** **Vite** (`npm run dev` na porta `5174` por padrão, para não conflitar caso o front-end do `DockerCode` esteja aberto na `5173`).
- **UI Framework:** **React 19** (JavaScript/JSX modular).
- **Renderização da Topologia e Animação de Pacotes:**
  - **SVG Interativo em Camadas + CSS/RAF (RequestAnimationFrame):** Permite desenhar cabos curvos/ortogonais estilo Packet Tracer, calcular posições exatas $(x, y)$ dos pacotes (PDUs) ao longo dos enlaces, dar zoom/pan ou redimensionar sem perda de nitidez, e criar/destruir nós dinâmicos (como os containers efêmeros `dockercode-<jobId>`).
- **Estilização:** CSS moderno com variáveis de tema escuro (*Dark Network Operations Center / Packet Tracer Pro*), indicadores luminosos de status (LEDs), badges de protocolo e painéis redimensionáveis.
- **Dependências:** Leve e autocontido (`react`, `react-dom`, `vite`, `@vitejs/plugin-react`), sem necessidade de bibliotecas pesadas de grafos que dificultem a customização visual dos envelopes e inspetores.

---

## 2. Estrutura de Diretórios Prevista para `dockertracer/`

Quando o código for iniciado, a pasta `dockertracer/` seguirá a seguinte organização:

```text
dockertracer/
├── docs/ ou raiz (.md)              # Documentação de arquitetura e especificação (já criada)
│   ├── README.md
│   ├── ARQUITETURA_DOCKERCODE.md
│   ├── ESPECIFICACAO_SIMULADOR.md
│   └── PLANO_IMPLEMENTACAO.md
├── index.html
├── package.json                     # Scripts: "dev": "vite", "build": "vite build"
├── vite.config.js                   # Configuração Vite + proxy opcional para o DockerCode real
└── src/
    ├── main.jsx
    ├── App.jsx                      # Layout principal (Toolbar, Canvas, Sidebar, Event Log)
    ├── styles/
    │   └── tracer.css               # Tema Packet Tracer Dark, animações de LEDs e cabos
    ├── topology/
    │   ├── nodesConfig.js           # Coordenadas, portas, metadados e ícones dos nós fixos
    │   └── linksConfig.js           # Definição dos enlaces (HTTP, REST, AMQP, SQL, Socket)
    ├── engine/
    │   ├── simulationEngine.js      # Motor de eventos discretos (Realtime & Step-by-Step)
    │   ├── jobStateMachine.js       # Regras fiéis ao SubmissionApi, ResultService e Worker
    │   ├── presets.js               # Catálogo dos 6 cenários pré-configurados e payloads
    │   └── liveBridge.js            # (Opcional) Modo híbrido disparando contra localhost:8080
    └── components/
        ├── TopToolbar.jsx           # Seletor de cenários, botões de disparo e injeção de caos
        ├── TopologyCanvas.jsx       # Mapa visual SVG/HTML com nós, cabos, LEDs e sandboxes
        ├── PacketEnvelope.jsx       # Renderização dos envelopes (PDUs) viajando pelos cabos
        ├── SimulationControls.jsx   # Controles Realtime vs Step-by-Step, Play/Pause/Next, Speed
        ├── EventLogPanel.jsx        # Lista cronológica de PDUs estilo Packet Tracer
        ├── PduInspectorModal.jsx    # Detalhes de camadas/headers/JSON ao clicar em um pacote
        └── DeviceInspectorPanel.jsx # Estado interno ao clicar em Nginx, RabbitMQ, PG, Worker, Sandbox
```

---

## 3. Modelagem do Motor de Simulação (`simulationEngine.js`)

O coração do **DockerTracer** será um **Motor de Eventos Discretos e Passos de Protocolo** determinístico, que modela fielmente o estado interno de cada componente do `DockerCode`:

### 3.1. Estado Interno Simulado por Dispositivo
- **`nginxState`**:
  - `activeConnections: { "submission-api-1": 0, "submission-api-2": 0 }`
  - `totalRouted: { "submission-api-1": 0, "submission-api-2": 0 }`
  - Regra de roteamento real: escolhe a réplica saudável com menor `activeConnections` (`least_conn`).
- **`rabbitMqState`**:
  - `healthy: true`
  - `queueName: "execution.jobs"`
  - `readyMessages: []` (mensagens aguardando Worker livre)
  - `unackedMessages: Map<deliveryTag, { jobId, workerId, correlationId }>`
- **`postgresState` (`jobsTable`)**:
  - Mapa/Lista de registros contendo exatamente as colunas de `ResultService/Program.cs`:
    `id, language, source_code, stdin, status, created_at, started_at, finished_at, worker_id, lease_until, lease_token, stdout, stderr, exit_code, failure_reason, correlation_id, attempt_count`.
- **`workersState` (`worker-1`, `worker-2`)**:
  - `healthy: true`, `busy: false`, `currentJobId: null`, `leaseToken: null`, `heartbeatTimer: 0`, `dockerStep: "IDLE"`.
- **`dockerEngineState`**:
  - `activeVolumes: Map<volumeName, { size: "32m", driver: "tmpfs", mode: "0700,exec" }>`
  - `activeSandboxes: Map<containerId, { name, jobId, workerId, language, image, state, limits }>`
  - `completedSandboxesCount: 0`, `orphanContainers: 0`, `orphanVolumes: 0`.

### 3.2. Funcionamento dos Modos `Realtime` vs `Step-by-Step`
- Cada operação de rede gera um objeto `PDU` com:
  - `id`, `timestamp`, `jobId`, `correlationId`, `protocol` (`HTTP`, `REST`, `SQL`, `AMQP`, `DOCKER_SOCK`), `fromNode`, `toNode`, `linkId`, `progress` ($0.0 \rightarrow 1.0$), `title`, `requestPayload`, `responsePayload`.
- Quando um `PDU` chega a `progress === 1.0` no nó de destino (`toNode`), o motor executa o **Handler de Chegada** daquele nó (por exemplo, inserir no PostgreSQL, enfileirar no RabbitMQ ou criar o container efêmero no Docker Engine) e emite o próximo `PDU` da cadeia.
- No **Modo Realtime**, `progress` avança continuamente a cada frame de acordo com o multiplicador de velocidade (`0.25x` a `4x`).
- No **Modo Simulation (Passo a Passo)**, a simulação pausa automaticamente a cada chegada/emissão de `PDU`, permitindo que o apresentador clique em **`⏭ Próximo Passo (Capture/Forward)`** e explique exatamente o que acabou de acontecer no nó atual e qual pacote está saindo para o próximo nó.

---

## 4. Modo Autônomo vs. Modo Conectado (Live Bridge Opcional)

O `DockerTracer` operará prioritariamente em **Modo Simulado Autônomo** (não exige que o Docker Desktop esteja consumindo RAM para demonstrar a arquitetura em qualquer computador), mas poderá contar também com um **Modo Live / Híbrido**:

1. **Modo Simulado Autônomo (Padrão):**
   - Funciona 100% no navegador via `npm run dev`.
   - Permite pausar o tempo (Step-by-Step), inspecionar frames internos (`PUT /archive`, `Claim`, `Heartbeat`, `BasicAck`) e injetar falhas (derrubar Worker ou RabbitMQ com um clique) sem precisar derrubar containers reais.
2. **Modo Live Trigger (Opcional):**
   - Quando o `DockerCode` estiver rodando em `http://localhost:8080`, o usuário pode disparar um Job real a partir do `DockerTracer`, medir os tempos reais (`ingestMs`, `queueMs`, `execMs`) retornados por `GET /api/jobs/{id}` (`createdAt`, `startedAt`, `finishedAt`) e reproduzir a animação no mapa topológico calibrada com os tempos reais daquela execução.

---

## 5. Roteiro de Implementação (Próximas Etapas)

Assim que você autorizar o início da codificação, seguiremos esta sequência:

1. **Etapa 1 — Bootstrap do Projeto Vite + React em `dockertracer/`:**
   - Criar `package.json`, `vite.config.js`, `index.html` e estrutura base em `src/`.
2. **Etapa 2 — Motor de Simulação Fiel ao `DockerCode` (`src/engine/`):**
   - Implementar a máquina de estados dos Jobs, balanceador `least_conn`, fila RabbitMQ com `prefetch=1`, *claims/leases* no PostgreSQL e ciclo de containers/volumes `tmpfs` no Docker Engine.
3. **Etapa 3 — Canvas de Topologia Estilo Packet Tracer (`src/components/TopologyCanvas.jsx`):**
   - Renderizar as 5 zonas, os nós fixos, os slots dinâmicos de sandboxes efêmeros, os enlaces coloridos por protocolo, os LEDs de porta e os envelopes `PDU` animados.
4. **Etapa 4 — Painéis de Inspeção e Controles de Simulação:**
   - Implementar a barra de controles (`Realtime` / `Step-by-Step`, `Play/Pause/Next`, velocidade), a tabela de eventos (`EventLogPanel`), o inspetor de pacotes (`PduInspectorModal`) e o inspetor de dispositivos (`DeviceInspectorPanel`).
5. **Etapa 5 — Cenários Pré-Configurados, Injeção de Falhas e Validação (`npm run dev`):**
   - Configurar os 6 cenários de teste/caos e validar o funcionamento visual completo no navegador.
