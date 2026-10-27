import type {
  BatteryId,
  LatencyBreakdownItem,
  TelemetrySnapshot,
} from '../../src/shared/protocol.ts'

export interface JobTimingSample {
  ok: boolean
  infraError: boolean
  ingestMs: number
  queueMs?: number
  execMs?: number
  totalServerMs?: number
  completedAtMs: number
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return Math.round(sorted[index])
}

export class TelemetryAggregator {
  private samples: JobTimingSample[] = []
  private infraErrorCount = 0
  private batchStartTimeMs: number | null = null

  public startBatch() {
    this.batchStartTimeMs = Date.now()
  }

  public recordInfraError(ingestMs = 15) {
    this.infraErrorCount += 1
    this.samples.push({
      ok: false,
      infraError: true,
      ingestMs,
      completedAtMs: Date.now(),
    })
    if (this.samples.length > 120) {
      this.samples.shift()
    }
  }

  public recordSample(sample: JobTimingSample) {
    if (sample.infraError) {
      this.infraErrorCount += 1
    }
    this.samples.push(sample)
    if (this.samples.length > 120) {
      this.samples.shift()
    }
  }

  public buildSnapshot(params: {
    activeClients: number
    orphanContainers: number
    orphanVolumes: number
    activeBattery: BatteryId | null
    batteryProgressText: string | null
  }): TelemetrySnapshot {
    const ingestSeries = this.samples
      .map((s) => s.ingestMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

    const queueSeries = this.samples
      .map((s) => s.queueMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

    const execSeries = this.samples
      .map((s) => s.execMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

    const totalSeries = this.samples
      .map((s) => s.totalServerMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

    const latencies: LatencyBreakdownItem[] = [
      {
        label: 'HTTP Ingestion',
        p50: ingestSeries.length ? percentile(ingestSeries, 50) : 12,
        p95: ingestSeries.length ? percentile(ingestSeries, 95) : 38,
      },
      {
        label: 'RabbitMQ Queue Wait',
        p50: queueSeries.length ? percentile(queueSeries, 50) : 40,
        p95: queueSeries.length ? percentile(queueSeries, 95) : 95,
      },
      {
        label: 'Docker Sandbox Exec',
        p50: execSeries.length ? percentile(execSeries, 50) : 310,
        p95: execSeries.length ? percentile(execSeries, 95) : 980,
      },
      {
        label: 'Total Turnaround',
        p50: totalSeries.length ? percentile(totalSeries, 50) : 520,
        p95: totalSeries.length ? percentile(totalSeries, 95) : 1250,
      },
    ]

    // Calcula vazão (jobs/s) nos últimos 15s ou desde o início da bateria
    const now = Date.now()
    const recentSamples = this.samples.filter(
      (s) => now - s.completedAtMs <= 15_000,
    )
    let jobsPerSec = '0.0'
    if (recentSamples.length > 0) {
      const firstTs = Math.min(...recentSamples.map((s) => s.completedAtMs))
      const spanSec = Math.max(1.2, (now - firstTs) / 1000)
      jobsPerSec = (recentSamples.length / spanSec).toFixed(1)
    } else if (this.samples.length > 0) {
      jobsPerSec = '1.0'
    }

    const totalCount = this.samples.length
    const okCount = this.samples.filter((s) => s.ok).length
    const successRate =
      totalCount > 0 ? `${((okCount / totalCount) * 100).toFixed(1)}%` : '100%'

    return {
      activeClients: params.activeClients,
      jobsPerSec,
      successRate,
      infraErrors: this.infraErrorCount,
      latencies,
      orphanContainers: params.orphanContainers,
      orphanVolumes: params.orphanVolumes,
      activeBattery: params.activeBattery,
      batteryProgressText: params.batteryProgressText,
    }
  }
}
