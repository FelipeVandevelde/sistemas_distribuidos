import { randomUUID } from 'node:crypto'
import type {
  ActivePduEnvelope,
  BatteryId,
  BehaviorProfileLabel,
  ChaosKey,
  EphemeralClientNode,
  LanguageLabel,
  PlaybackMode,
  SandboxSlotState,
  SingleJobConfig,
  TracerStateSnapshot,
} from '../../src/shared/protocol.ts'
import { DockerCodeLiveObserver } from '../bridge/dockerCodeLiveObserver.ts'
import { BatteryRunner } from '../suites/batteryRunner.ts'
import { ChaosController } from '../suites/chaosController.ts'
import { TelemetryAggregator } from '../suites/telemetryAggregator.ts'
import { createInitialSnapshot } from '../tracerServer.ts'
import { getExecutionPreset } from './codePresets.ts'
import {
  evaluateSingleJobStep,
  getStepLabels,
  type EvaluatedStepDetails,
  type RealExecutionTrace,
} from './stepCatalog.ts'

const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'TIMEOUT'])

export interface ActiveClientSession {
  clientId: string
  clientLabel: string
  job: SingleJobConfig
  currentStepIndex: number
  playing: boolean
  aborted: boolean
  timer: ReturnType<typeof setInterval> | null
  createdAtMs: number
  completedAtMs: number | null
}

export class SimulationEngine {
  private state: TracerStateSnapshot
  private onUpdate: (snapshot: TracerStateSnapshot) => void
  private observer: DockerCodeLiveObserver
  private telemetry: TelemetryAggregator
  private chaosController: ChaosController
  private batteryRunner: BatteryRunner
  private infraPollTimer: ReturnType<typeof setInterval> | null = null
  private sessions = new Map<string, ActiveClientSession>()
  private focusedJobId: string
  private realTraces = new Map<string, RealExecutionTrace>()
  private recordedSampleJobIds = new Set<string>()
  private clientCounter = 1
  private isPollingInfra = false
  private lastMqSnap: { healthy: boolean; ready: number; unacked: number } = {
    healthy: true,
    ready: 0,
    unacked: 0,
  }
  private lastDockerSnap: {
    dockerHealthy: boolean
    worker1Running: boolean
    worker1Paused: boolean
    worker2Running: boolean
    rabbitRunning: boolean
    nginxRunning: boolean
    activeSandboxNames: string[]
    orphanContainers: number
    orphanVolumes: number
  } | null = null

  constructor(onUpdate: (snapshot: TracerStateSnapshot) => void) {
    this.onUpdate = onUpdate
    this.state = createInitialSnapshot()
    this.observer = new DockerCodeLiveObserver()
    this.telemetry = new TelemetryAggregator()
    this.chaosController = new ChaosController()
    this.batteryRunner = new BatteryRunner(
      this.observer,
      this.telemetry,
      () => {
        this.recomputeAggregateState(
          this.lastMqSnap,
          this.lastDockerSnap ?? undefined,
        )
        this.emit()
      },
    )

    const initialJob = this.state.singleJob
    this.focusedJobId = initialJob.activeJobId
    this.sessions.set(initialJob.activeJobId, {
      clientId: initialJob.clientId,
      clientLabel: initialJob.clientLabel,
      job: { ...initialJob },
      currentStepIndex: 7,
      playing: false,
      aborted: false,
      timer: null,
      createdAtMs: Date.now(),
      completedAtMs: null,
    })

    this.observer.startDockerEventsStream(() => {
      void this.refreshLiveInfrastructure()
    })

    this.infraPollTimer = setInterval(() => {
      void this.refreshLiveInfrastructure()
    }, 550)

    this.recomputeAggregateState()
    void this.refreshLiveInfrastructure()
  }

  public getObserver(): DockerCodeLiveObserver {
    return this.observer
  }

  public getState(): TracerStateSnapshot {
    this.state.serverTimestamp = new Date().toISOString()
    return this.state
  }

  public async toggleBattery(suiteId: BatteryId): Promise<TracerStateSnapshot> {
    await this.batteryRunner.toggleBattery(suiteId)
    await this.refreshLiveInfrastructure()
    return this.state
  }

  public async toggleChaos(
    key: ChaosKey,
    explicitValue?: boolean,
  ): Promise<TracerStateSnapshot> {
    const nextChaos = await this.chaosController.toggleChaos(
      key,
      explicitValue,
      () => {
        // Se houver bateria ativa, aborta 1 request em voo da bateria; senão aborta o cliente focado
        const abortedBatteryReq = this.batteryRunner.abortOneActiveRequest()
        if (!abortedBatteryReq) {
          const focused = this.getFocusedSession()
          if (focused) {
            focused.aborted = true
            this.stopSessionPlayback(focused)
          }
        }
      },
    )

    this.state.chaos = { ...nextChaos }
    if (key === 'req' && !nextChaos.req) {
      for (const s of this.sessions.values()) {
        s.aborted = false
      }
    }

    await this.refreshLiveInfrastructure()
    this.recomputeAggregateState(
      this.lastMqSnap,
      this.lastDockerSnap ?? undefined,
    )
    this.emit()
    return this.state
  }

  public async refreshLiveInfrastructure(): Promise<void> {
    if (this.isPollingInfra) return
    this.isPollingInfra = true

    try {
      const [pgSnap, mqSnap, dockerSnap] = await Promise.all([
        this.observer.queryPostgresJobs(25),
        this.observer.queryRabbitQueue(),
        this.observer.inspectDockerState(),
      ])

      this.lastMqSnap = mqSnap
      this.lastDockerSnap = dockerSnap

      const isLive = pgSnap.healthy && dockerSnap.dockerHealthy
      this.state.liveBridgeAvailable = isLive
      this.state.executionMode = isLive ? 'LIVE' : 'SIMULATED'

      if (isLive) {
        this.state.nodes.pg.healthy = pgSnap.healthy
        this.state.nodes.pg.totalRows = pgSnap.counts.total
        this.state.nodes.pg.queuedCount = pgSnap.counts.queued
        this.state.nodes.pg.runningCount = pgSnap.counts.running
        this.state.nodes.pg.terminalCount = pgSnap.counts.terminal
        this.state.nodes.pg.jobs = pgSnap.jobs

        this.state.nodes.mq.healthy =
          mqSnap.healthy && dockerSnap.rabbitRunning && !this.state.chaos.mq
        this.state.nodes.docker.healthy = dockerSnap.dockerHealthy
        this.state.nodes.docker.orphanContainers = dockerSnap.orphanContainers
        this.state.nodes.docker.orphanVolumes = dockerSnap.orphanVolumes

        for (const [jobId, session] of this.sessions.entries()) {
          const matchedRow = pgSnap.jobs.find((j) => j.id === jobId) ?? null
          if (!matchedRow) continue

          if (matchedRow.worker_id === 'worker-1') {
            session.job.assignedWorker = 'w1'
          } else if (matchedRow.worker_id === 'worker-2') {
            session.job.assignedWorker = 'w2'
          }

          const existing = this.realTraces.get(jobId)
          const createdMs = matchedRow.created_at
            ? Date.parse(matchedRow.created_at)
            : NaN
          const startedMs = matchedRow.started_at
            ? Date.parse(matchedRow.started_at)
            : NaN
          const finishedMs = matchedRow.finished_at
            ? Date.parse(matchedRow.finished_at)
            : NaN

          const queueMs =
            Number.isFinite(createdMs) && Number.isFinite(startedMs)
              ? Math.max(0, Math.round(startedMs - createdMs))
              : (existing?.queueMs ?? null)

          const execMs =
            Number.isFinite(startedMs) && Number.isFinite(finishedMs)
              ? Math.max(1, Math.round(finishedMs - startedMs))
              : (existing?.execMs ?? null)

          const capturedContainer =
            this.observer.getCapturedContainerName(jobId) ??
            existing?.realContainerName ??
            null

          this.realTraces.set(jobId, {
            pgRow: matchedRow,
            realContainerName: capturedContainer,
            ingestMs: existing?.ingestMs ?? 15,
            queueMs,
            execMs,
            httpStatus: existing?.httpStatus ?? 202,
            errorDetail: existing?.errorDetail ?? null,
          })

          if (TERMINAL_STATES.has(matchedRow.status)) {
            session.completedAtMs = session.completedAtMs ?? Date.now()
          }

          if (
            TERMINAL_STATES.has(matchedRow.status) &&
            !this.recordedSampleJobIds.has(jobId)
          ) {
            this.recordedSampleJobIds.add(jobId)
            const isInfraErr =
              matchedRow.failure_reason === 'BROKER_UNAVAILABLE' ||
              matchedRow.failure_reason === 'INFRA_ERROR'
            const qVal = queueMs ?? 20
            const eVal = execMs ?? 150
            this.telemetry.recordSample({
              ok: !isInfraErr,
              infraError: isInfraErr,
              ingestMs: existing?.ingestMs ?? 15,
              queueMs: qVal,
              execMs: eVal,
              totalServerMs: qVal + eVal,
              completedAtMs: Date.now(),
            })
          }
        }
      }

      this.recomputeAggregateState(mqSnap, dockerSnap)
      this.emit()
    } finally {
      this.isPollingInfra = false
    }
  }

  public selectPreset(params: {
    languageLabel?: LanguageLabel
    profileLabel?: BehaviorProfileLabel
    stdin?: string
    sourceCode?: string
  }): TracerStateSnapshot {
    const nextLang = params.languageLabel ?? this.state.composer.languageLabel
    const nextProfile = params.profileLabel ?? this.state.composer.profileLabel
    const preset = getExecutionPreset(nextLang, nextProfile)

    const langOrProfileChanged =
      nextLang !== this.state.composer.languageLabel ||
      nextProfile !== this.state.composer.profileLabel

    this.state.composer.languageLabel = preset.languageLabel
    this.state.composer.language = preset.language
    this.state.composer.profileLabel = preset.profileLabel
    this.state.composer.profile = preset.profile
    this.state.composer.sourceCode = langOrProfileChanged
      ? preset.sourceCode
      : (params.sourceCode ?? this.state.composer.sourceCode)
    this.state.composer.stdin =
      params.stdin !== undefined
        ? params.stdin
        : langOrProfileChanged
          ? preset.defaultStdin
          : this.state.composer.stdin

    this.emit()
    return this.state
  }

  public async dispatchSingleJob(params?: {
    languageLabel?: LanguageLabel
    profileLabel?: BehaviorProfileLabel
    stdin?: string
    sourceCode?: string
  }): Promise<TracerStateSnapshot> {
    if (params) {
      this.selectPreset(params)
    }

    const demoId = '7f3a9d12-4c8e-4b10-9a21-00d8f29e1cc1'
    if (this.sessions.has(demoId) && !this.realTraces.has(demoId)) {
      this.stopSessionPlayback(this.sessions.get(demoId)!)
      this.sessions.delete(demoId)
      this.clientCounter = 0
    }

    for (const [prevJobId, prevSession] of Array.from(
      this.sessions.entries(),
    )) {
      if (this.isSessionConcluded(prevJobId, prevSession)) {
        this.stopSessionPlayback(prevSession)
        this.sessions.delete(prevJobId)
      } else if (prevSession.currentStepIndex < 21 && !prevSession.playing) {
        this.startSessionPlayback(prevSession)
      }
    }

    this.clientCounter += 1
    const clientNum = String(this.clientCounter).padStart(2, '0')
    const clientId = `client-${clientNum}`
    const clientLabel = `Client #${clientNum}`
    const correlationId = randomUUID().replace(/-/g, '')

    const nextApi: 'api1' | 'api2' =
      this.state.nodes.ngx.totalRoutedApi1 <=
      this.state.nodes.ngx.totalRoutedApi2
        ? 'api1'
        : 'api2'
    if (nextApi === 'api1') {
      this.state.nodes.ngx.totalRoutedApi1 += 1
    } else {
      this.state.nodes.ngx.totalRoutedApi2 += 1
    }

    const defaultWorker: 'w1' | 'w2' = this.state.chaos.w1
      ? 'w2'
      : this.clientCounter % 2 === 1
        ? 'w1'
        : 'w2'

    const draft = this.state.composer

    const submission = await this.observer.submitRealJob({
      language: draft.language,
      sourceCode: draft.sourceCode,
      stdin: draft.stdin,
      correlationId,
    })

    if (submission.httpStatus === 503 || !submission.ok) {
      this.telemetry.recordInfraError(submission.ingestMs)
    }

    const activeJobId = submission.jobId ?? randomUUID()

    const newJobConfig: SingleJobConfig = {
      clientId,
      clientLabel,
      languageLabel: draft.languageLabel,
      language: draft.language,
      profileLabel: draft.profileLabel,
      profile: draft.profile,
      sourceCode: draft.sourceCode,
      stdin: draft.stdin,
      activeJobId,
      correlationId: submission.correlationId,
      routedApi: nextApi,
      assignedWorker: defaultWorker,
    }

    this.realTraces.set(activeJobId, {
      pgRow: null,
      realContainerName: null,
      ingestMs: submission.ingestMs,
      queueMs: null,
      execMs: null,
      httpStatus: submission.httpStatus,
      errorDetail: submission.errorDetail,
    })

    const newSession: ActiveClientSession = {
      clientId,
      clientLabel,
      job: newJobConfig,
      currentStepIndex: submission.httpStatus === 503 ? 5 : 0,
      playing: false,
      aborted: false,
      timer: null,
      createdAtMs: Date.now(),
      completedAtMs: submission.httpStatus === 503 ? Date.now() : null,
    }

    this.sessions.set(activeJobId, newSession)
    this.focusedJobId = activeJobId

    this.pruneOldFinishedSessions()

    if (submission.jobId) {
      void this.trackRealSingleJobExecution(submission.jobId)
    }

    if (this.state.playbackMode === 'rt' && submission.httpStatus !== 503) {
      this.startSessionPlayback(newSession)
    }

    this.recomputeAggregateState(
      this.lastMqSnap,
      this.lastDockerSnap ?? undefined,
    )
    this.emit()
    return this.state
  }

  public focusClient(targetId: string): TracerStateSnapshot {
    for (const [jobId, session] of this.sessions.entries()) {
      if (jobId === targetId || session.clientId === targetId) {
        this.focusedJobId = jobId
        this.recomputeAggregateState(
          this.lastMqSnap,
          this.lastDockerSnap ?? undefined,
        )
        this.emit()
        break
      }
    }
    return this.state
  }

  private isSessionConcluded(
    jobId: string,
    sess: ActiveClientSession,
  ): boolean {
    if (sess.completedAtMs !== null) return true
    if (sess.currentStepIndex >= 21) return true
    if (sess.aborted) return true
    const trace = this.realTraces.get(jobId)
    if (trace) {
      if (trace.httpStatus !== null && trace.httpStatus >= 400) return true
      if (trace.pgRow && TERMINAL_STATES.has(trace.pgRow.status)) return true
    }
    return false
  }

  private pruneOldFinishedSessions() {
    for (const [jobId, sess] of Array.from(this.sessions.entries())) {
      if (
        jobId !== this.focusedJobId &&
        this.isSessionConcluded(jobId, sess)
      ) {
        this.stopSessionPlayback(sess)
        this.sessions.delete(jobId)
      }
    }
  }

  private async trackRealSingleJobExecution(jobId: string): Promise<void> {
    const deadline = Date.now() + 32_000

    while (Date.now() < deadline) {
      const session = this.sessions.get(jobId)
      if (!session) return

      const pgSnap = await this.observer.queryPostgresJobs(20)
      const row = pgSnap.jobs.find((j) => j.id === jobId) ?? null
      const capturedContainer = this.observer.getCapturedContainerName(jobId)

      if (row) {
        if (row.worker_id === 'worker-1') {
          session.job.assignedWorker = 'w1'
        } else if (row.worker_id === 'worker-2') {
          session.job.assignedWorker = 'w2'
        }

        const existing = this.realTraces.get(jobId)
        const createdMs = row.created_at ? Date.parse(row.created_at) : NaN
        const startedMs = row.started_at ? Date.parse(row.started_at) : NaN
        const finishedMs = row.finished_at ? Date.parse(row.finished_at) : NaN

        const queueMs =
          Number.isFinite(createdMs) && Number.isFinite(startedMs)
            ? Math.max(0, Math.round(startedMs - createdMs))
            : null
        const execMs =
          Number.isFinite(startedMs) && Number.isFinite(finishedMs)
            ? Math.max(1, Math.round(finishedMs - startedMs))
            : null

        this.realTraces.set(jobId, {
          pgRow: row,
          realContainerName:
            capturedContainer ?? existing?.realContainerName ?? null,
          ingestMs: existing?.ingestMs ?? 15,
          queueMs,
          execMs,
          httpStatus: existing?.httpStatus ?? 202,
          errorDetail: existing?.errorDetail ?? null,
        })

        this.recomputeAggregateState(
          this.lastMqSnap,
          this.lastDockerSnap ?? undefined,
        )
        this.emit()

        if (TERMINAL_STATES.has(row.status)) {
          session.completedAtMs = session.completedAtMs ?? Date.now()
          await this.refreshLiveInfrastructure()
          return
        }
      }

      await new Promise((r) => setTimeout(r, 180))
    }
  }

  public stepControl(params: {
    action: 'RESET' | 'NEXT' | 'PREV' | 'GOTO' | 'PLAY' | 'PAUSE' | 'TOGGLE_PLAY'
    stepIndex?: number
  }): TracerStateSnapshot {
    const session = this.getFocusedSession()
    if (!session) return this.state

    const { action, stepIndex } = params
    const maxStep = this.state.chaos.mq ? 5 : 21

    if (action === 'RESET') {
      this.stopSessionPlayback(session)
      session.currentStepIndex = 0
      session.completedAtMs = null
    } else if (action === 'NEXT') {
      const next = Math.min(maxStep, session.currentStepIndex + 1)
      session.currentStepIndex = next
      if (next >= maxStep) {
        session.completedAtMs = session.completedAtMs ?? Date.now()
        this.stopSessionPlayback(session)
      }
    } else if (action === 'PREV') {
      this.stopSessionPlayback(session)
      session.currentStepIndex = Math.max(0, session.currentStepIndex - 1)
      session.completedAtMs = null
    } else if (action === 'GOTO' && typeof stepIndex === 'number') {
      this.stopSessionPlayback(session)
      session.currentStepIndex = Math.max(0, Math.min(21, stepIndex))
      session.completedAtMs =
        session.currentStepIndex >= maxStep ? Date.now() : null
    } else if (action === 'PLAY') {
      if (session.currentStepIndex >= maxStep) {
        session.currentStepIndex = 0
        session.completedAtMs = null
      }
      this.startSessionPlayback(session)
    } else if (action === 'PAUSE') {
      this.stopSessionPlayback(session)
    } else if (action === 'TOGGLE_PLAY') {
      if (session.playing) {
        this.stopSessionPlayback(session)
      } else {
        if (session.currentStepIndex >= maxStep) {
          session.currentStepIndex = 0
          session.completedAtMs = null
        }
        this.startSessionPlayback(session)
      }
    }

    this.recomputeAggregateState(
      this.lastMqSnap,
      this.lastDockerSnap ?? undefined,
    )
    this.emit()
    return this.state
  }

  public setModeAndSpeed(params: {
    playbackMode?: PlaybackMode
    speedMultiplier?: number
  }): TracerStateSnapshot {
    const focused = this.getFocusedSession()

    if (params.playbackMode) {
      this.state.playbackMode = params.playbackMode
      if (
        params.playbackMode === 'rt' &&
        focused &&
        focused.currentStepIndex < 21
      ) {
        this.startSessionPlayback(focused)
      } else if (params.playbackMode === 'step' && focused) {
        this.stopSessionPlayback(focused)
      }
    }

    if (
      typeof params.speedMultiplier === 'number' &&
      params.speedMultiplier >= 0.25 &&
      params.speedMultiplier <= 4
    ) {
      this.state.speedMultiplier = params.speedMultiplier
      for (const sess of this.sessions.values()) {
        if (sess.playing) {
          this.startSessionPlayback(sess)
        }
      }
    }

    this.recomputeAggregateState(
      this.lastMqSnap,
      this.lastDockerSnap ?? undefined,
    )
    this.emit()
    return this.state
  }

  private startSessionPlayback(session: ActiveClientSession) {
    this.stopSessionPlayback(session)
    session.playing = true
    const intervalMs = Math.max(
      150,
      Math.round(520 / this.state.speedMultiplier),
    )

    session.timer = setInterval(() => {
      const maxStep = this.state.chaos.mq ? 5 : 21
      const trace = this.realTraces.get(session.job.activeJobId)
      const rowStatus = trace?.pgRow?.status

      if (
        this.state.liveBridgeAvailable &&
        trace?.pgRow &&
        rowStatus === 'RUNNING' &&
        session.currentStepIndex === 13
      ) {
        this.recomputeAggregateState(
          this.lastMqSnap,
          this.lastDockerSnap ?? undefined,
        )
        this.emit()
        return
      }

      if (session.currentStepIndex >= maxStep) {
        session.completedAtMs = session.completedAtMs ?? Date.now()
        this.stopSessionPlayback(session)
        this.recomputeAggregateState(
          this.lastMqSnap,
          this.lastDockerSnap ?? undefined,
        )
        this.emit()
        return
      }

      session.currentStepIndex += 1
      if (session.currentStepIndex >= maxStep) {
        session.completedAtMs = Date.now()
        this.stopSessionPlayback(session)
      }

      this.recomputeAggregateState(
        this.lastMqSnap,
        this.lastDockerSnap ?? undefined,
      )
      this.emit()
    }, intervalMs)
  }

  private stopSessionPlayback(session: ActiveClientSession) {
    session.playing = false
    if (session.timer) {
      clearInterval(session.timer)
      session.timer = null
    }
  }

  private getFocusedSession(): ActiveClientSession | null {
    const direct = this.sessions.get(this.focusedJobId)
    if (direct) return direct
    const all = Array.from(this.sessions.values())
    if (all.length === 0) return null
    const latest = all[all.length - 1]
    this.focusedJobId = latest.job.activeJobId
    return latest
  }

  public recomputeAggregateState(
    mqSnap?: { healthy: boolean; ready: number; unacked: number },
    dockerSnap?: {
      worker1Paused?: boolean
      rabbitRunning?: boolean
      activeSandboxNames: string[]
      orphanContainers?: number
      orphanVolumes?: number
    },
  ) {
    const focused = this.getFocusedSession()
    const allSessions = Array.from(this.sessions.values())
    const evaluatedMap = new Map<string, EvaluatedStepDetails>()

    for (const sess of allSessions) {
      const preset = getExecutionPreset(
        sess.job.languageLabel,
        sess.job.profileLabel,
      )
      const trace = this.realTraces.get(sess.job.activeJobId)
      const ev = evaluateSingleJobStep(
        sess.currentStepIndex,
        sess.job,
        preset,
        this.state.chaos,
        trace,
      )
      evaluatedMap.set(sess.job.activeJobId, ev)
    }

    if (focused) {
      const focusedEv = evaluatedMap.get(focused.job.activeJobId)!
      this.state.singleJob = focused.job
      this.state.currentStepIndex = focused.currentStepIndex
      this.state.playing = focused.playing
      this.state.stepLabels = getStepLabels(
        focused.job.routedApi,
        focused.job.assignedWorker,
      )
      this.state.currentXRay = focusedEv.xray
    }

    const activeBattery = this.batteryRunner.getActiveBattery()
    const pgRunningJobs = this.state.nodes.pg.jobs.filter(
      (j) => j.status === 'RUNNING',
    )

    if (activeBattery) {
      const batClients = this.batteryRunner.getBatteryClients()
      this.state.clients = batClients
      this.state.activePdus = this.batteryRunner.getBatteryPdus()

      const activeInFlight = batClients.filter(
        (c) => c.status === 'SUBMITTING' || c.status === 'POLLING 750ms',
      ).length
      const half = Math.ceil(activeInFlight / 2)
      this.state.nodes.ngx.api1Conn = half
      this.state.nodes.ngx.api2Conn = Math.max(0, activeInFlight - half)
      this.state.nodes.api1.activeRequests = this.state.nodes.ngx.api1Conn
      this.state.nodes.api2.activeRequests = this.state.nodes.ngx.api2Conn

      const readyVal = Math.max(
        mqSnap?.ready ?? 0,
        this.state.nodes.pg.queuedCount,
      )
      const unackedVal = Math.max(
        mqSnap?.unacked ?? 0,
        this.state.nodes.pg.runningCount,
      )
      this.state.nodes.mq.ready = readyVal
      this.state.nodes.mq.unacked = unackedVal
      this.state.nodes.mq.readyPct = Math.min(
        75,
        Math.round((readyVal / 24) * 100),
      )
      this.state.nodes.mq.unackedPct = Math.min(20, unackedVal * 10)
    } else {
      const clientNodes: EphemeralClientNode[] = allSessions.map((sess) => {
        const ev = evaluatedMap.get(sess.job.activeJobId)!
        const shortLang =
          sess.job.language === 'python'
            ? 'Python'
            : sess.job.language === 'javascript'
              ? 'Node'
              : sess.job.language === 'java'
                ? 'Java'
                : 'C++'
        return {
          id: sess.clientId,
          label: sess.clientLabel,
          languageLabel: shortLang,
          status:
            sess.aborted || this.state.chaos.req ? 'ABORTED' : ev.clientStatus,
          jobId: sess.job.activeJobId,
          correlationId: sess.job.correlationId,
        }
      })
      this.state.clients = clientNodes

      const combinedPdus: ActivePduEnvelope[] = []
      for (const sess of allSessions) {
        const ev = evaluatedMap.get(sess.job.activeJobId)!
        const isFocused = sess.job.activeJobId === this.focusedJobId
        const isRunning = sess.currentStepIndex < 21 && !sess.aborted
        if (isFocused || isRunning) {
          for (const pdu of ev.activePdus) {
            combinedPdus.push({
              ...pdu,
              id: `${sess.clientId}-${pdu.id}`,
            })
          }
        }
      }
      this.state.activePdus = combinedPdus

      let api1Conn = 0
      let api2Conn = 0
      let readySum = 0
      let unackedSum = 0

      for (const sess of allSessions) {
        const step = sess.currentStepIndex
        const ev = evaluatedMap.get(sess.job.activeJobId)!
        if (step <= 5 || step === 20) {
          if (sess.job.routedApi === 'api1') api1Conn += 1
          else api2Conn += 1
        }
        readySum += ev.rabbitReadyCount
        unackedSum += ev.rabbitUnackedCount
      }

      this.state.nodes.ngx.api1Conn = api1Conn
      this.state.nodes.ngx.api2Conn = api2Conn
      this.state.nodes.api1.activeRequests = api1Conn
      this.state.nodes.api2.activeRequests = api2Conn

      const finalReady = Math.max(readySum, mqSnap?.ready ?? 0)
      const finalUnacked = Math.max(unackedSum, mqSnap?.unacked ?? 0)
      this.state.nodes.mq.ready = finalReady
      this.state.nodes.mq.unacked = finalUnacked
      this.state.nodes.mq.readyPct = Math.min(80, finalReady * 20)
      this.state.nodes.mq.unackedPct = Math.min(20, finalUnacked * 10)
    }

    // Atualiza estado dos Workers (combinando linhas reais RUNNING do Postgres + sessões da Aba 1)
    for (const wKey of ['w1', 'w2'] as const) {
      const workerName = wKey === 'w1' ? 'worker-1' : 'worker-2'
      const wNode = this.state.nodes[wKey]
      const isW1Stopped =
        wKey === 'w1' &&
        (this.state.chaos.w1 || Boolean(dockerSnap?.worker1Paused))
      wNode.crashed = isW1Stopped
      wNode.healthy = !isW1Stopped

      const realRunningOnWorker = pgRunningJobs.find(
        (j) => j.worker_id === workerName,
      )

      const activeSessOnWorker = allSessions
        .slice()
        .reverse()
        .find((s) => {
          const tr = this.realTraces.get(s.job.activeJobId)
          const reclaimed = this.state.chaos.w1 && s.currentStepIndex >= 8
          const w: 'w1' | 'w2' =
            tr?.pgRow?.worker_id === 'worker-2'
              ? 'w2'
              : tr?.pgRow?.worker_id === 'worker-1'
                ? 'w1'
                : reclaimed
                  ? 'w2'
                  : s.job.assignedWorker
          return (
            w === wKey && s.currentStepIndex >= 6 && s.currentStepIndex <= 19
          )
        })

      if (realRunningOnWorker) {
        wNode.busy = !isW1Stopped
        wNode.currentJobId = realRunningOnWorker.id
        wNode.leaseRemainingSec = realRunningOnWorker.lease_remaining_sec ?? 18
        wNode.heartbeatActive = !isW1Stopped
        wNode.dockerStep = isW1Stopped
          ? 'CRASHED_LEASE_EXPIRING'
          : 'EXECUTING_SANDBOX'
        wNode.attemptCount = realRunningOnWorker.attempt_count
        wNode.leaseToken = realRunningOnWorker.lease_token
      } else if (activeSessOnWorker && !isW1Stopped) {
        const ev = evaluatedMap.get(activeSessOnWorker.job.activeJobId)!
        const tr = this.realTraces.get(activeSessOnWorker.job.activeJobId)
        wNode.busy = true
        wNode.currentJobId = activeSessOnWorker.job.activeJobId
        wNode.leaseRemainingSec = ev.workerLeaseRemainingSec
        wNode.heartbeatActive = ev.workerHeartbeatActive
        wNode.dockerStep = ev.workerDockerStep
        wNode.attemptCount = tr?.pgRow?.attempt_count ?? 1
        wNode.leaseToken =
          tr?.pgRow?.lease_token ?? 'b91e-44d2-8a11-9c04f1e2a3b4'
      } else {
        wNode.busy = false
        wNode.currentJobId = null
        wNode.leaseRemainingSec = 0
        wNode.heartbeatActive = false
        wNode.dockerStep = isW1Stopped ? 'CRASHED' : 'IDLE'
        wNode.attemptCount = 0
        wNode.leaseToken = null
      }
    }

    // Atualiza slots do Docker Engine (priorizando containers reais em execução + sessões ativas)
    const liveSlots = this.observer.buildSandboxSlots(
      dockerSnap?.activeSandboxNames ?? [],
      this.state.nodes.pg.jobs,
    )

    if (liveSlots.some((s) => s.active)) {
      this.state.nodes.docker.slots = liveSlots
    } else {
      const activeSessionSandboxes = allSessions
        .filter((s) => {
          const ev = evaluatedMap.get(s.job.activeJobId)!
          return ev.sandboxSlotActive
        })
        .slice(-3)

      const slots: SandboxSlotState[] = [1, 2, 3].map((slotIndex, idx) => {
        const sess = activeSessionSandboxes[idx]
        if (sess) {
          const ev = evaluatedMap.get(sess.job.activeJobId)!
          const tr = this.realTraces.get(sess.job.activeJobId)
          const fullC =
            tr?.realContainerName ||
            `dockercode-${sess.job.activeJobId.slice(0, 8)}-${sess.job.activeJobId.slice(-6)}`
          const shortC = `dockercode-${sess.job.activeJobId.slice(0, 8)}-${fullC.slice(-6)}`
          return {
            slotIndex,
            active: true,
            containerName: shortC,
            volumeName: shortC,
            jobId: sess.job.activeJobId,
            workerId:
              sess.job.assignedWorker === 'w1' ? 'worker-1' : 'worker-2',
            language: sess.job.language,
            status: ev.sandboxSlotStatus,
            specs: `${sess.clientLabel} · tmpfs 32MB | 256MB | net:none`,
          }
        }

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
      })

      this.state.nodes.docker.slots = slots
    }

    // Atualiza Telemetria P50/P95, Vazão e Auditoria
    this.state.telemetry = this.telemetry.buildSnapshot({
      activeClients: this.state.clients.length,
      orphanContainers: this.state.nodes.docker.orphanContainers,
      orphanVolumes: this.state.nodes.docker.orphanVolumes,
      activeBattery,
      batteryProgressText: this.batteryRunner.getProgressText(),
    })
  }

  private emit() {
    this.state.serverTimestamp = new Date().toISOString()
    this.onUpdate(this.state)
  }
}
