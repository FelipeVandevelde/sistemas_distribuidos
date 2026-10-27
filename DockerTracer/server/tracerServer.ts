import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { TracerStateSnapshot } from '../src/shared/protocol.ts'
import { SimulationEngine } from './engine/simulationEngine.ts'

const STEP_LABELS: string[] = [
  'HTTP POST /api/jobs',
  'Nginx least_conn → api-1',
  'Submission API validate (≤64KB)',
  'ResultService SQL INSERT QUEUED',
  'RabbitMQ Publish + Confirm',
  'HTTP 202 Accepted',
  'worker-1 basic.consume (prefetch=1)',
  'worker-1 Claim + LeaseToken (20s)',
  'Heartbeat start (5s)',
  'Docker Create Volume tmpfs (32m, exec)',
  'Docker Create Container (net:none, ro)',
  'Container Start (wait .ready)',
  'PutArchive .tar (code + stdin + .ready)',
  'Wait Container (timeout 10s)',
  'Get Logs (8B demux) & Inspect OOM',
  'Delete Container (force=true&v=true)',
  'Delete Volume (force=true)',
  'ResultService Complete (SQL UPDATE)',
  'RabbitMQ BasicAck',
  'Stop Heartbeat & Release Lease',
  'Polling GET /api/jobs/{id} (750ms)',
  '200 OK Terminal Result',
]

export function createInitialSnapshot(): TracerStateSnapshot {
  const nowIso = new Date().toISOString()
  return {
    version: '1.0.0-part2',
    serverTimestamp: nowIso,
    executionMode: 'SIMULATED',
    liveBridgeAvailable: false,
    playbackMode: 'step',
    playing: false,
    speedMultiplier: 1,
    currentStepIndex: 7,
    totalSteps: STEP_LABELS.length,
    stepLabels: STEP_LABELS,
    composer: {
      languageLabel: 'Python 3.12',
      language: 'python',
      profileLabel: 'Execução Limpa (Sucesso)',
      profile: 'SUCCESS',
      sourceCode: `name = input()\nprint(f"Olá, {name}!")`,
      stdin: 'DockerTracer',
    },
    singleJob: {
      clientId: 'client-01',
      clientLabel: 'Client #01',
      languageLabel: 'Python 3.12',
      language: 'python',
      profileLabel: 'Execução Limpa (Sucesso)',
      profile: 'SUCCESS',
      sourceCode: `name = input()\nprint(f"Olá, {name}!")`,
      stdin: 'DockerTracer',
      activeJobId: '7f3a9d12-4c8e-4b10-9a21-00d8f29e1cc1',
      correlationId: 'c0rr3l4t10n7f3a9d124c8e4b109a21',
      routedApi: 'api1',
      assignedWorker: 'w1',
    },
    currentXRay: {
      stepIndex: 7,
      stepNumber: '08',
      title: STEP_LABELS[7],
      protocol: 'rest',
      fromNode: 'w1',
      toNode: 'rs',
      jsonPayload: '',
      pgRowText: '',
      sandboxOutputText: '',
    },
    clients: [
      {
        id: 'client-01',
        label: 'Client #01',
        languageLabel: 'Python',
        status: 'POLLING 750ms',
        jobId: '7f3a9d12-4c8e-4b10-9a21-00d8f29e1cc1',
        correlationId: 'c0rr3l4t10n7f3a9d124c8e4b109a21',
      },
    ],
    nodes: {
      ngx: {
        healthy: true,
        algorithm: 'least_conn',
        api1Conn: 1,
        api2Conn: 0,
        totalRoutedApi1: 1,
        totalRoutedApi2: 0,
      },
      api1: {
        healthy: true,
        port: ':8081',
        activeRequests: 1,
        rabbitConfirmSelect: true,
      },
      api2: {
        healthy: true,
        port: ':8080',
        activeRequests: 0,
        rabbitConfirmSelect: true,
      },
      mq: {
        healthy: true,
        queueName: 'execution.jobs',
        ready: 0,
        unacked: 1,
        readyPct: 0,
        unackedPct: 14,
      },
      rs: {
        healthy: true,
        sqlPoolActive: 2,
        sqlPoolMax: 10,
        lastOperation: 'POST /internal/jobs/{id}/claim',
      },
      pg: {
        healthy: true,
        totalRows: 1,
        queuedCount: 0,
        runningCount: 1,
        terminalCount: 0,
        jobs: [],
      },
      w1: {
        id: 'worker-1',
        healthy: true,
        crashed: false,
        busy: true,
        currentJobId: '7f3a9d12-4c8e-4b10-9a21-00d8f29e1cc1',
        leaseTotalSec: 20,
        leaseRemainingSec: 18,
        leaseToken: 'b91e-44d2-8a11-9c04f1e2a3b4',
        heartbeatIntervalSec: 5,
        heartbeatActive: true,
        dockerStep: 'CLAIM_ACQUIRED',
        attemptCount: 1,
      },
      w2: {
        id: 'worker-2',
        healthy: true,
        crashed: false,
        busy: false,
        currentJobId: null,
        leaseTotalSec: 20,
        leaseRemainingSec: 0,
        leaseToken: null,
        heartbeatIntervalSec: 5,
        heartbeatActive: false,
        dockerStep: 'IDLE',
        attemptCount: 0,
      },
      docker: {
        healthy: true,
        socketPath: '/var/run/docker.sock',
        slots: [
          {
            slotIndex: 1,
            active: false,
            containerName: null,
            volumeName: null,
            jobId: null,
            workerId: null,
            language: null,
            status: 'FREE',
            specs: 'slot livre',
          },
          {
            slotIndex: 2,
            active: false,
            containerName: null,
            volumeName: null,
            jobId: null,
            workerId: null,
            language: null,
            status: 'FREE',
            specs: 'slot livre',
          },
          {
            slotIndex: 3,
            active: false,
            containerName: null,
            volumeName: null,
            jobId: null,
            workerId: null,
            language: null,
            status: 'FREE',
            specs: 'slot livre',
          },
        ],
        orphanContainers: 0,
        orphanVolumes: 0,
      },
    },
    activePdus: [],
    chaos: {
      w1: false,
      mq: false,
      req: false,
      lastChaosEvent: null,
    },
    telemetry: {
      activeClients: 1,
      jobsPerSec: '1.2',
      successRate: '100%',
      infraErrors: 0,
      latencies: [
        { label: 'HTTP Ingestion', p50: 12, p95: 38 },
        { label: 'RabbitMQ Queue Wait', p50: 40, p95: 95 },
        { label: 'Docker Sandbox Exec', p50: 310, p95: 980 },
        { label: 'Total Turnaround', p50: 520, p95: 1250 },
      ],
      orphanContainers: 0,
      orphanVolumes: 0,
      activeBattery: null,
      batteryProgressText: null,
    },
  }
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

export function dockerTracerBackendPlugin(): Plugin {
  const sseClients = new Set<ServerResponse>()
  let engine: SimulationEngine | null = null

  function getEngine(): SimulationEngine {
    if (!engine) {
      engine = new SimulationEngine((snapshot) => {
        const payload = `data: ${JSON.stringify(snapshot)}\n\n`
        for (const client of sseClients) {
          client.write(payload)
        }
      })
    }
    return engine
  }

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) {
    const url = req.url?.split('?')[0] ?? ''
    if (!url.startsWith('/api/tracer')) {
      return next()
    }

    const activeEngine = getEngine()

    if (req.method === 'GET' && url === '/api/tracer/health') {
      return sendJson(res, 200, {
        status: 'Healthy',
        service: 'dockertracer-backend',
        phase: 'part-4-visual-refinement-complete',
        timestamp: new Date().toISOString(),
      })
    }

    if (req.method === 'GET' && url === '/api/tracer/state') {
      return sendJson(res, 200, activeEngine.getState())
    }

    if (req.method === 'GET' && url === '/api/tracer/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify(activeEngine.getState())}\n\n`)
      sseClients.add(res)
      req.on('close', () => {
        sseClients.delete(res)
      })
      return
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req)

      if (url === '/api/tracer/preset') {
        const snapshot = activeEngine.selectPreset(body)
        return sendJson(res, 200, snapshot)
      }

      if (url === '/api/tracer/single-job') {
        const snapshot = await activeEngine.dispatchSingleJob(body)
        return sendJson(res, 200, snapshot)
      }

      if (url === '/api/tracer/focus-client') {
        const snapshot = activeEngine.focusClient(String(body.targetId ?? ''))
        return sendJson(res, 200, snapshot)
      }

      if (url === '/api/tracer/step') {
        const snapshot = activeEngine.stepControl(body as any)
        return sendJson(res, 200, snapshot)
      }

      if (url === '/api/tracer/mode') {
        const snapshot = activeEngine.setModeAndSpeed(body)
        return sendJson(res, 200, snapshot)
      }

      if (url === '/api/tracer/suite') {
        const snapshot = await activeEngine.toggleBattery(body.suiteId)
        return sendJson(res, 200, snapshot)
      }

      if (url === '/api/tracer/chaos') {
        const snapshot = await activeEngine.toggleChaos(body.key, body.active)
        return sendJson(res, 200, snapshot)
      }

      return sendJson(res, 200, activeEngine.getState())
    }

    return sendJson(res, 404, { message: `Rota não encontrada: ${url}` })
  }

  return {
    name: 'dockertracer-backend',
    configureServer(server) {
      getEngine()
      server.middlewares.use((req, res, next) => {
        void handleRequest(req, res, next)
      })
    },
    configurePreviewServer(server) {
      getEngine()
      server.middlewares.use((req, res, next) => {
        void handleRequest(req, res, next)
      })
    },
  }
}
