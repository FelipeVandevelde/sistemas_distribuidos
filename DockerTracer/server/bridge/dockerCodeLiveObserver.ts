import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { PostgresJobRow, SandboxSlotState } from '../../src/shared/protocol.ts'

const execFileAsync = promisify(execFile)

const DOCKERCODE_BASE_URL = (
  process.env.DOCKERCODE_URL || 'http://localhost:8080'
).replace(/\/$/, '')
const RABBITMQ_MGMT_URL =
  process.env.RABBITMQ_MGMT_URL ||
  'http://localhost:15672/api/queues/%2F/execution.jobs'
const RABBITMQ_AUTH = Buffer.from('dockercode:dockercode').toString('base64')

export interface RealInfraPollSnapshot {
  liveAvailable: boolean
  nginxHealthy: boolean
  postgresHealthy: boolean
  rabbitHealthy: boolean
  worker1Healthy: boolean
  worker1PausedOrStopped: boolean
  worker2Healthy: boolean
  rabbitReady: number
  rabbitUnacked: number
  pgJobs: PostgresJobRow[]
  pgTotalCount: number
  pgQueuedCount: number
  pgRunningCount: number
  pgTerminalCount: number
  activeSandboxes: Array<{
    containerName: string
    jobIdHex: string
    status: 'CREATING' | 'RUNNING' | 'KILLING' | 'CLEANUP'
  }>
  orphanContainers: number
  orphanVolumes: number
}

export interface RealJobSubmissionResult {
  ok: boolean
  httpStatus: number
  jobId: string | null
  status: string | null
  correlationId: string
  ingestMs: number
  errorDetail: string | null
}

export class DockerCodeLiveObserver {
  private eventsProcess: ChildProcess | null = null
  private liveContainers = new Map<
    string,
    {
      containerName: string
      jobIdHex: string
      status: 'CREATING' | 'RUNNING' | 'KILLING' | 'CLEANUP'
      updatedAt: number
    }
  >()
  private lastCapturedContainerByJobHex = new Map<string, string>()
  private onDockerEventCallback: (() => void) | null = null

  public startDockerEventsStream(onEvent: () => void) {
    this.onDockerEventCallback = onEvent
    if (this.eventsProcess) return

    try {
      const proc = spawn(
        'docker',
        ['events', '--format', '{{json .}}'],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      )
      this.eventsProcess = proc

      let buffer = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line)
            this.handleDockerEvent(ev)
          } catch {
            // ignore malformed event line
          }
        }
      })

      proc.on('exit', () => {
        this.eventsProcess = null
      })
      proc.on('error', () => {
        this.eventsProcess = null
      })
    } catch {
      this.eventsProcess = null
    }
  }

  private handleDockerEvent(ev: any) {
    const type = ev?.Type
    const action = String(ev?.Action || '')
    const name: string =
      ev?.Actor?.Attributes?.name || ev?.Actor?.ID || ''

    // Detecta sandboxes efêmeros: dockercode-<32hex>-<6hex>
    const match = /^dockercode-([0-9a-f]{32})-([0-9a-f]{6})$/i.exec(name)
    if (type === 'container' && match) {
      const jobIdHex = match[1].toLowerCase()
      const shortName = `dockercode-${jobIdHex.slice(0, 8)}-${match[2]}`
      this.lastCapturedContainerByJobHex.set(jobIdHex, name)

      if (action === 'create') {
        this.liveContainers.set(name, {
          containerName: shortName,
          jobIdHex,
          status: 'CREATING',
          updatedAt: Date.now(),
        })
        this.onDockerEventCallback?.()
      } else if (action === 'start' || action.startsWith('archive-path')) {
        this.liveContainers.set(name, {
          containerName: shortName,
          jobIdHex,
          status: 'RUNNING',
          updatedAt: Date.now(),
        })
        this.onDockerEventCallback?.()
      } else if (action === 'kill' || action === 'oom') {
        const existing = this.liveContainers.get(name)
        if (existing) {
          existing.status = 'KILLING'
          existing.updatedAt = Date.now()
          this.onDockerEventCallback?.()
        }
      } else if (action === 'die') {
        const existing = this.liveContainers.get(name)
        if (existing) {
          existing.status = 'CLEANUP'
          existing.updatedAt = Date.now()
          this.onDockerEventCallback?.()
        }
      } else if (action === 'destroy') {
        this.liveContainers.delete(name)
        this.onDockerEventCallback?.()
      }
    }
  }

  public getCapturedContainerName(jobId: string): string | null {
    const hex = jobId.replace(/-/g, '').toLowerCase()
    return this.lastCapturedContainerByJobHex.get(hex) ?? null
  }

  public async submitRealJob(params: {
    language: string
    sourceCode: string
    stdin: string
    correlationId: string
    signal?: AbortSignal
  }): Promise<RealJobSubmissionResult> {
    const t0 = performance.now()
    try {
      const res = await fetch(`${DOCKERCODE_BASE_URL}/api/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': params.correlationId,
        },
        body: JSON.stringify({
          language: params.language,
          sourceCode: params.sourceCode,
          stdin: params.stdin,
        }),
        signal: params.signal,
      })

      const ingestMs = Math.round(performance.now() - t0)
      const text = await res.text()
      let parsed: any = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }

      if (!res.ok) {
        return {
          ok: false,
          httpStatus: res.status,
          jobId: parsed?.jobId ?? null,
          status: 'FAILED',
          correlationId:
            res.headers.get('x-correlation-id') ?? params.correlationId,
          ingestMs,
          errorDetail:
            parsed?.detail || parsed?.message || parsed?.title || text,
        }
      }

      return {
        ok: true,
        httpStatus: res.status,
        jobId: parsed?.jobId ?? null,
        status: parsed?.status ?? 'QUEUED',
        correlationId:
          res.headers.get('x-correlation-id') ?? params.correlationId,
        ingestMs,
        errorDetail: null,
      }
    } catch (err: any) {
      return {
        ok: false,
        httpStatus: 0,
        jobId: null,
        status: null,
        correlationId: params.correlationId,
        ingestMs: Math.round(performance.now() - t0),
        errorDetail: err?.message ?? 'Falha de conexão com localhost:8080',
      }
    }
  }

  public async getJobViaPublicApi(jobId: string, signal?: AbortSignal) {
    try {
      const res = await fetch(`${DOCKERCODE_BASE_URL}/api/jobs/${jobId}`, {
        signal,
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  public async queryPostgresJobs(limit = 25): Promise<{
    healthy: boolean
    jobs: PostgresJobRow[]
    counts: { total: number; queued: number; running: number; terminal: number }
  }> {
    const sql = `
      SELECT json_build_object(
        'total', (SELECT COUNT(*)::int FROM jobs),
        'queued', (SELECT COUNT(*)::int FROM jobs WHERE status = 'QUEUED'),
        'running', (SELECT COUNT(*)::int FROM jobs WHERE status = 'RUNNING'),
        'terminal', (SELECT COUNT(*)::int FROM jobs WHERE status IN ('SUCCEEDED','FAILED','TIMEOUT')),
        'rows', COALESCE((
          SELECT json_agg(t) FROM (
            SELECT
              id::text AS id,
              language,
              source_code,
              stdin,
              status,
              created_at,
              started_at,
              finished_at,
              worker_id,
              lease_until,
              CASE
                WHEN lease_until IS NULL THEN 0
                ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (lease_until - NOW()))))::int
              END AS lease_remaining_sec,
              lease_token::text AS lease_token,
              stdout,
              stderr,
              exit_code,
              failure_reason,
              correlation_id,
              attempt_count
            FROM jobs
            ORDER BY created_at DESC
            LIMIT ${Number(limit)}
          ) t
        ), '[]'::json)
      );
    `
    try {
      const { stdout } = await execFileAsync(
        'docker',
        [
          'exec',
          'dockercode-postgres-1',
          'psql',
          '-U',
          'dockercode',
          '-d',
          'dockercode',
          '-t',
          '-A',
          '-c',
          sql,
        ],
        { timeout: 3000, windowsHide: true },
      )
      const parsed = JSON.parse(stdout.trim())
      return {
        healthy: true,
        jobs: (parsed.rows ?? []) as PostgresJobRow[],
        counts: {
          total: parsed.total ?? 0,
          queued: parsed.queued ?? 0,
          running: parsed.running ?? 0,
          terminal: parsed.terminal ?? 0,
        },
      }
    } catch {
      return {
        healthy: false,
        jobs: [],
        counts: { total: 0, queued: 0, running: 0, terminal: 0 },
      }
    }
  }

  public async queryRabbitQueue(): Promise<{
    healthy: boolean
    ready: number
    unacked: number
  }> {
    try {
      const res = await fetch(RABBITMQ_MGMT_URL, {
        headers: { Authorization: `Basic ${RABBITMQ_AUTH}` },
        signal: AbortSignal.timeout(1800),
      })
      if (!res.ok) return { healthy: false, ready: 0, unacked: 0 }
      const data: any = await res.json()
      return {
        healthy: true,
        ready: Number(data?.messages_ready ?? 0),
        unacked: Number(data?.messages_unacknowledged ?? 0),
      }
    } catch {
      return { healthy: false, ready: 0, unacked: 0 }
    }
  }

  public async inspectDockerState(): Promise<{
    dockerHealthy: boolean
    worker1Running: boolean
    worker1Paused: boolean
    worker2Running: boolean
    rabbitRunning: boolean
    nginxRunning: boolean
    activeSandboxNames: string[]
    orphanContainers: number
    orphanVolumes: number
  }> {
    try {
      const { stdout: psOut } = await execFileAsync(
        'docker',
        ['ps', '-a', '--format', '{{.Names}}|{{.State}}|{{.Status}}'],
        { timeout: 3000, windowsHide: true },
      )
      const lines = psOut.split(/\r?\n/).filter(Boolean)

      let worker1Running = false
      let worker1Paused = false
      let worker2Running = false
      let rabbitRunning = false
      let nginxRunning = false
      const activeSandboxNames: string[] = []
      let exitedSandboxes = 0

      for (const line of lines) {
        const [name, state, status] = line.split('|')
        const isPaused = status?.toLowerCase().includes('paused') ?? false
        if (name === 'dockercode-worker-1-1') {
          worker1Running = state === 'running' && !isPaused
          worker1Paused = isPaused || state !== 'running'
        } else if (name === 'dockercode-worker-2-1') {
          worker2Running = state === 'running' && !isPaused
        } else if (name === 'dockercode-rabbitmq-1') {
          rabbitRunning = state === 'running' && !isPaused
        } else if (name === 'dockercode-frontend-1') {
          nginxRunning = state === 'running'
        } else if (/^dockercode-[0-9a-f]{32}-[0-9a-f]{6}$/i.test(name)) {
          if (state === 'running' || state === 'created') {
            activeSandboxNames.push(name)
          } else {
            exitedSandboxes += 1
          }
        }
      }

      const { stdout: volOut } = await execFileAsync(
        'docker',
        [
          'volume',
          'ls',
          '--filter',
          'name=dockercode-',
          '--format',
          '{{.Name}}',
        ],
        { timeout: 2500, windowsHide: true },
      )
      const sandboxVolumes = volOut
        .split(/\r?\n/)
        .map((v) => v.trim())
        .filter((v) => /^dockercode-[0-9a-f]{32}-[0-9a-f]{6}$/i.test(v))

      // Volumes de sandboxes que não pertencem a nenhum container ativo são órfãos
      const activeSet = new Set(activeSandboxNames)
      const orphanVolumes = sandboxVolumes.filter((v) => !activeSet.has(v)).length

      return {
        dockerHealthy: true,
        worker1Running,
        worker1Paused,
        worker2Running,
        rabbitRunning,
        nginxRunning,
        activeSandboxNames,
        orphanContainers: exitedSandboxes,
        orphanVolumes,
      }
    } catch {
      return {
        dockerHealthy: false,
        worker1Running: false,
        worker1Paused: false,
        worker2Running: false,
        rabbitRunning: false,
        nginxRunning: false,
        activeSandboxNames: [],
        orphanContainers: 0,
        orphanVolumes: 0,
      }
    }
  }

  public buildSandboxSlots(
    activeSandboxNames: string[],
    pgJobs: PostgresJobRow[],
  ): SandboxSlotState[] {
    // Combina containers vistos via docker events + docker ps
    const combinedNames = Array.from(
      new Set([
        ...Array.from(this.liveContainers.keys()),
        ...activeSandboxNames,
      ]),
    ).slice(0, 3)

    return [1, 2, 3].map((slotIndex, idx) => {
      const fullName = combinedNames[idx]
      if (!fullName) {
        return {
          slotIndex,
          active: false,
          containerName: null,
          volumeName: null,
          jobId: null,
          workerId: null,
          language: null,
          status: 'FREE',
          specs: 'slot livre',
        }
      }

      const match = /^dockercode-([0-9a-f]{32})-([0-9a-f]{6})$/i.exec(fullName)
      const jobHex = match?.[1]?.toLowerCase() ?? ''
      const suffix = match?.[2] ?? 'sandbox'
      const shortName = jobHex
        ? `dockercode-${jobHex.slice(0, 8)}-${suffix}`
        : fullName

      const matchedJob = pgJobs.find(
        (j) => j.id.replace(/-/g, '').toLowerCase() === jobHex,
      )
      const evState = this.liveContainers.get(fullName)

      return {
        slotIndex,
        active: true,
        containerName: shortName,
        volumeName: shortName,
        jobId: matchedJob?.id ?? null,
        workerId:
          (matchedJob?.worker_id as 'worker-1' | 'worker-2' | null) ?? null,
        language: matchedJob?.language ?? null,
        status: evState?.status ?? 'RUNNING',
        specs: 'tmpfs 32MB | 256MB | net:none | ro-rootfs',
      }
    })
  }
}
