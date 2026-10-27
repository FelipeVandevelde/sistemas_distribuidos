export type LanguageId = 'python' | 'javascript' | 'java' | 'cpp'
export type LanguageLabel = 'Python 3.12' | 'Node.js 22' | 'Java 21' | 'C++ 14'

export type BehaviorProfileId =
  | 'SUCCESS'
  | 'COMPILE_ERROR'
  | 'RUNTIME_ERROR'
  | 'MEMORY_LIMIT'
  | 'TIMEOUT'

export type BehaviorProfileLabel =
  | 'Execução Limpa (Sucesso)'
  | 'Erro de Compilação (javac/g++)'
  | 'Erro de Runtime'
  | 'Estouro de Memória (OOM 256MB)'
  | 'Loop Infinito (Timeout 10s)'

export type ProtocolType = 'http' | 'rest' | 'amqp' | 'sql' | 'sock'

export type FixedNodeId =
  | 'ngx'
  | 'api1'
  | 'api2'
  | 'mq'
  | 'rs'
  | 'pg'
  | 'w1'
  | 'w2'
  | 'docker'

export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMEOUT'

export type FailureReason =
  | 'COMPILE_ERROR'
  | 'RUNTIME_ERROR'
  | 'MEMORY_LIMIT'
  | 'TIMEOUT'
  | 'BROKER_UNAVAILABLE'
  | 'INFRA_ERROR'
  | 'INVALID_LANGUAGE'
  | null

export type ClientVisualStatus =
  | 'SUBMITTING'
  | 'POLLING 750ms'
  | '200 OK'
  | 'ABORTED'
  | '503 ERROR'
  | '400 BAD REQ'

export interface EphemeralClientNode {
  id: string
  label: string
  languageLabel: string
  status: ClientVisualStatus
  jobId?: string
  correlationId?: string
}

export interface SandboxSlotState {
  slotIndex: number
  active: boolean
  containerName: string | null
  volumeName: string | null
  jobId: string | null
  workerId: 'worker-1' | 'worker-2' | null
  language: LanguageId | null
  status: 'FREE' | 'CREATING' | 'RUNNING' | 'KILLING' | 'CLEANUP'
  specs: string
}

export interface ActivePduEnvelope {
  id: string
  from: string
  to: string
  protocol: ProtocolType
  color: string
  label: string
  stepIndex?: number
  jobId?: string
  correlationId?: string
  durationSec: number
  payloadSummary: string
}

export interface PostgresJobRow {
  id: string
  language: LanguageId
  source_code: string
  stdin: string
  status: JobStatus
  created_at: string
  started_at: string | null
  finished_at: string | null
  worker_id: string | null
  lease_until: string | null
  lease_remaining_sec: number | null
  lease_token: string | null
  stdout: string | null
  stderr: string | null
  exit_code: number | null
  failure_reason: FailureReason
  correlation_id: string
  attempt_count: number
}

export interface StepXRayInspector {
  stepIndex: number
  stepNumber: string
  title: string
  protocol: ProtocolType
  fromNode: string
  toNode: string
  jsonPayload: string
  pgRowText: string
  sandboxOutputText: string
}

export interface WorkerRuntimeState {
  id: 'worker-1' | 'worker-2'
  healthy: boolean
  crashed: boolean
  busy: boolean
  currentJobId: string | null
  leaseTotalSec: number
  leaseRemainingSec: number
  leaseToken: string | null
  heartbeatIntervalSec: number
  heartbeatActive: boolean
  dockerStep: string
  attemptCount: number
}

export interface NodesRuntimeState {
  ngx: {
    healthy: boolean
    algorithm: 'least_conn'
    api1Conn: number
    api2Conn: number
    totalRoutedApi1: number
    totalRoutedApi2: number
  }
  api1: {
    healthy: boolean
    port: ':8081'
    activeRequests: number
    rabbitConfirmSelect: boolean
  }
  api2: {
    healthy: boolean
    port: ':8080'
    activeRequests: number
    rabbitConfirmSelect: boolean
  }
  mq: {
    healthy: boolean
    queueName: 'execution.jobs'
    ready: number
    unacked: number
    readyPct: number
    unackedPct: number
  }
  rs: {
    healthy: boolean
    sqlPoolActive: number
    sqlPoolMax: number
    lastOperation: string
  }
  pg: {
    healthy: boolean
    totalRows: number
    queuedCount: number
    runningCount: number
    terminalCount: number
    jobs: PostgresJobRow[]
  }
  w1: WorkerRuntimeState
  w2: WorkerRuntimeState
  docker: {
    healthy: boolean
    socketPath: '/var/run/docker.sock'
    slots: SandboxSlotState[]
    orphanContainers: number
    orphanVolumes: number
  }
}

export type PlaybackMode = 'rt' | 'step'
export type ExecutionMode = 'SIMULATED' | 'LIVE'
export type BatteryId = 'smoke' | 'burst' | 'drop' | 'hostile'
export type ChaosKey = 'w1' | 'mq' | 'req'

export interface ChaosState {
  w1: boolean
  mq: boolean
  req: boolean
  lastChaosEvent: string | null
}

export interface LatencyBreakdownItem {
  label: string
  p50: number
  p95: number
}

export interface TelemetrySnapshot {
  activeClients: number
  jobsPerSec: string
  successRate: string
  infraErrors: number
  latencies: LatencyBreakdownItem[]
  orphanContainers: number
  orphanVolumes: number
  activeBattery: BatteryId | null
  batteryProgressText: string | null
}

export interface ComposerDraftConfig {
  languageLabel: LanguageLabel
  language: LanguageId
  profileLabel: BehaviorProfileLabel
  profile: BehaviorProfileId
  sourceCode: string
  stdin: string
}

export interface SingleJobConfig {
  clientId: string
  clientLabel: string
  languageLabel: LanguageLabel
  language: LanguageId
  profileLabel: BehaviorProfileLabel
  profile: BehaviorProfileId
  sourceCode: string
  stdin: string
  activeJobId: string
  correlationId: string
  routedApi: 'api1' | 'api2'
  assignedWorker: 'w1' | 'w2'
}

export interface TracerStateSnapshot {
  version: string
  serverTimestamp: string
  executionMode: ExecutionMode
  liveBridgeAvailable: boolean
  playbackMode: PlaybackMode
  playing: boolean
  speedMultiplier: number
  currentStepIndex: number
  totalSteps: number
  stepLabels: string[]
  composer: ComposerDraftConfig
  singleJob: SingleJobConfig
  currentXRay: StepXRayInspector
  clients: EphemeralClientNode[]
  nodes: NodesRuntimeState
  activePdus: ActivePduEnvelope[]
  chaos: ChaosState
  telemetry: TelemetrySnapshot
}
