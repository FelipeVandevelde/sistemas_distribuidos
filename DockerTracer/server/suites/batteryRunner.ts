import { randomUUID } from 'node:crypto'
import type {
  ActivePduEnvelope,
  BatteryId,
  ClientVisualStatus,
  EphemeralClientNode,
  LanguageId,
} from '../../src/shared/protocol.ts'
import type { DockerCodeLiveObserver } from '../bridge/dockerCodeLiveObserver.ts'
import { PROTOCOL_COLORS } from '../engine/stepCatalog.ts'
import type { TelemetryAggregator } from './telemetryAggregator.ts'

export interface BatteryCaseSpec {
  label: string
  shortLang: string
  language: LanguageId
  sourceCode: string
  stdin: string
  expectStatus?: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT'
  expectReason?: string | null
  abortAfterMs?: number
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMEOUT'])

export class BatteryRunner {
  private observer: DockerCodeLiveObserver
  private telemetry: TelemetryAggregator
  private onStateChanged: () => void
  private activeBattery: BatteryId | null = null
  private batteryProgressText: string | null = null
  private stopRequested = false
  private activeClients: EphemeralClientNode[] = []
  private activePdus: ActivePduEnvelope[] = []
  private activeAbortControllers = new Map<string, AbortController>()

  constructor(
    observer: DockerCodeLiveObserver,
    telemetry: TelemetryAggregator,
    onStateChanged: () => void,
  ) {
    this.observer = observer
    this.telemetry = telemetry
    this.onStateChanged = onStateChanged
  }

  public getActiveBattery(): BatteryId | null {
    return this.activeBattery
  }

  public getProgressText(): string | null {
    return this.batteryProgressText
  }

  public getBatteryClients(): EphemeralClientNode[] {
    return this.activeClients
  }

  public getBatteryPdus(): ActivePduEnvelope[] {
    return this.activePdus
  }

  public abortOneActiveRequest(): boolean {
    for (const [clientId, controller] of this.activeAbortControllers.entries()) {
      controller.abort()
      this.activeAbortControllers.delete(clientId)
      const client = this.activeClients.find((c) => c.id === clientId)
      if (client) {
        client.status = 'ABORTED'
      }
      this.onStateChanged()
      return true
    }
    return false
  }

  public stopBattery() {
    this.stopRequested = true
    for (const ctrl of this.activeAbortControllers.values()) {
      ctrl.abort()
    }
    this.activeAbortControllers.clear()
    this.activeBattery = null
    this.batteryProgressText = null
    this.activePdus = []
    this.onStateChanged()
  }

  public async toggleBattery(suiteId: BatteryId): Promise<void> {
    if (this.activeBattery === suiteId) {
      this.stopBattery()
      return
    }

    this.stopBattery()
    this.stopRequested = false
    this.activeBattery = suiteId
    this.telemetry.startBatch()

    const specs = this.buildSpecsForSuite(suiteId)
    const concurrency =
      suiteId === 'burst'
        ? 24
        : suiteId === 'hostile'
          ? 10
          : suiteId === 'drop'
            ? 6
            : 4 // smoke test roda em ondas de 4 para melhor visualização didática

    void this.executeSuiteLoop(suiteId, specs, concurrency)
  }

  private async executeSuiteLoop(
    suiteId: BatteryId,
    specs: BatteryCaseSpec[],
    concurrency: number,
  ) {
    let completed = 0
    const total = specs.length

    this.activeClients = specs.map((sp, i) => ({
      id: `bat-client-${i + 1}`,
      label: `Client #${String(i + 1).padStart(2, '0')}`,
      languageLabel: sp.shortLang,
      status: 'SUBMITTING',
    }))
    this.batteryProgressText = `${completed}/${total} concluídos`
    this.rebuildBatteryPdus()
    this.onStateChanged()

    let cursor = 0
    const worker = async () => {
      while (!this.stopRequested) {
        const idx = cursor
        cursor += 1
        if (idx >= specs.length) return
        await this.runSingleBatteryCase(idx, specs[idx])
        completed += 1
        if (!this.stopRequested && this.activeBattery === suiteId) {
          this.batteryProgressText = `${completed}/${total} concluídos`
          this.rebuildBatteryPdus()
          this.onStateChanged()
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, specs.length) },
      () => worker(),
    )
    await Promise.all(workers)

    if (!this.stopRequested && this.activeBattery === suiteId) {
      this.batteryProgressText = `✓ Concluído (${completed}/${total})`
      this.activePdus = []
      this.onStateChanged()
      // Mantém os cards visíveis por 4s após finalizar a bateria e depois libera o modo de bateria
      setTimeout(() => {
        if (this.activeBattery === suiteId) {
          this.activeBattery = null
          this.batteryProgressText = null
          this.onStateChanged()
        }
      }, 4500)
    }
  }

  private async runSingleBatteryCase(index: number, spec: BatteryCaseSpec) {
    const clientNode = this.activeClients[index]
    if (!clientNode) return

    const controller = new AbortController()
    this.activeAbortControllers.set(clientNode.id, controller)

    if (spec.abortAfterMs) {
      setTimeout(() => {
        controller.abort()
      }, spec.abortAfterMs)
    }

    const correlationId = randomUUID().replace(/-/g, '')
    clientNode.correlationId = correlationId
    clientNode.status = 'SUBMITTING'
    this.rebuildBatteryPdus()
    this.onStateChanged()

    const sub = await this.observer.submitRealJob({
      language: spec.language,
      sourceCode: spec.sourceCode,
      stdin: spec.stdin,
      correlationId,
      signal: controller.signal,
    })

    if (controller.signal.aborted) {
      clientNode.status = 'ABORTED'
      this.activeAbortControllers.delete(clientNode.id)
      this.telemetry.recordSample({
        ok: true,
        infraError: false,
        ingestMs: sub.ingestMs,
        completedAtMs: Date.now(),
      })
      return
    }

    if (!sub.ok || !sub.jobId) {
      const statusBadge: ClientVisualStatus =
        sub.httpStatus === 400
          ? '400 BAD REQ'
          : sub.httpStatus === 503
            ? '503 ERROR'
            : 'ABORTED'
      clientNode.status = statusBadge
      this.activeAbortControllers.delete(clientNode.id)
      const isExpected400 = sub.httpStatus === 400 && spec.shortLang === '>64KB'
      this.telemetry.recordSample({
        ok: isExpected400,
        infraError: sub.httpStatus === 503 || sub.httpStatus === 0,
        ingestMs: sub.ingestMs,
        completedAtMs: Date.now(),
      })
      return
    }

    clientNode.jobId = sub.jobId
    clientNode.status = 'POLLING 750ms'
    this.rebuildBatteryPdus()
    this.onStateChanged()

    const deadline = Date.now() + 45_000
    while (Date.now() < deadline && !this.stopRequested) {
      if (controller.signal.aborted) {
        clientNode.status = 'ABORTED'
        this.activeAbortControllers.delete(clientNode.id)
        this.telemetry.recordSample({
          ok: true,
          infraError: false,
          ingestMs: sub.ingestMs,
          completedAtMs: Date.now(),
        })
        return
      }

      const job = await this.observer.getJobViaPublicApi(
        sub.jobId,
        controller.signal,
      )
      if (job && TERMINAL.has(job.status)) {
        this.activeAbortControllers.delete(clientNode.id)
        const infraErr =
          job.failureReason === 'BROKER_UNAVAILABLE' ||
          job.failureReason === 'INFRA_ERROR'

        clientNode.status = infraErr ? '503 ERROR' : '200 OK'

        const createdAtMs = job.createdAt ? Date.parse(job.createdAt) : NaN
        const startedAtMs = job.startedAt ? Date.parse(job.startedAt) : NaN
        const finishedAtMs = job.finishedAt ? Date.parse(job.finishedAt) : NaN

        const queueMs =
          Number.isFinite(createdAtMs) && Number.isFinite(startedAtMs)
            ? Math.max(0, Math.round(startedAtMs - createdAtMs))
            : 25
        const execMs =
          Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
            ? Math.max(1, Math.round(finishedAtMs - startedAtMs))
            : 240
        const totalServerMs =
          Number.isFinite(createdAtMs) && Number.isFinite(finishedAtMs)
            ? Math.max(1, Math.round(finishedAtMs - createdAtMs))
            : queueMs + execMs

        const matchedExpectation =
          !spec.expectStatus || job.status === spec.expectStatus

        this.telemetry.recordSample({
          ok: matchedExpectation && !infraErr,
          infraError: infraErr,
          ingestMs: sub.ingestMs,
          queueMs,
          execMs,
          totalServerMs,
          completedAtMs: Date.now(),
        })
        return
      }

      await new Promise((r) => setTimeout(r, 320))
    }

    this.activeAbortControllers.delete(clientNode.id)
    clientNode.status = 'ABORTED'
  }

  private rebuildBatteryPdus() {
    const submitting = this.activeClients.filter(
      (c) => c.status === 'SUBMITTING',
    )
    const polling = this.activeClients.filter(
      (c) => c.status === 'POLLING 750ms',
    )
    const pdus: ActivePduEnvelope[] = []

    // Anima os enlaces ativos enquanto houver clientes submetendo ou em execução/polling
    for (const cl of submitting.slice(0, 8)) {
      pdus.push({
        id: `pdu-${cl.id}-post`,
        from: cl.id,
        to: 'ngx',
        protocol: 'http',
        color: PROTOCOL_COLORS.http,
        label: 'POST /api/jobs',
        durationSec: 1.1,
        payloadSummary: 'POST /api/jobs',
      })
    }

    for (const cl of polling.slice(0, 8)) {
      pdus.push({
        id: `pdu-${cl.id}-poll`,
        from: cl.id,
        to: 'ngx',
        protocol: 'http',
        color: PROTOCOL_COLORS.http,
        label: 'GET /api/jobs/{id}',
        durationSec: 1.4,
        payloadSummary: 'GET /api/jobs/{id}',
      })
    }

    if (submitting.length > 0 || polling.length > 0) {
      pdus.push(
        {
          id: 'bat-ngx-api1',
          from: 'ngx',
          to: 'api1',
          protocol: 'http',
          color: PROTOCOL_COLORS.http,
          label: 'least_conn → api-1',
          durationSec: 1.1,
          payloadSummary: 'Proxy least_conn',
        },
        {
          id: 'bat-ngx-api2',
          from: 'ngx',
          to: 'api2',
          protocol: 'http',
          color: PROTOCOL_COLORS.http,
          label: 'least_conn → api-2',
          durationSec: 1.2,
          payloadSummary: 'Proxy least_conn',
        },
        {
          id: 'bat-api1-rs',
          from: 'api1',
          to: 'rs',
          protocol: 'rest',
          color: PROTOCOL_COLORS.rest,
          label: '/internal/jobs',
          durationSec: 1.2,
          payloadSummary: 'REST /internal/jobs',
        },
        {
          id: 'bat-api2-rs',
          from: 'api2',
          to: 'rs',
          protocol: 'rest',
          color: PROTOCOL_COLORS.rest,
          label: '/internal/jobs',
          durationSec: 1.3,
          payloadSummary: 'REST /internal/jobs',
        },
        {
          id: 'bat-rs-pg',
          from: 'rs',
          to: 'pg',
          protocol: 'sql',
          color: PROTOCOL_COLORS.sql,
          label: 'SQL INSERT/UPDATE',
          durationSec: 1.0,
          payloadSummary: 'SQL jobs table',
        },
      )
    }

    if (polling.length > 0) {
      pdus.push(
        {
          id: 'bat-api1-mq',
          from: 'api1',
          to: 'mq',
          protocol: 'amqp',
          color: PROTOCOL_COLORS.amqp,
          label: 'BasicPublish',
          durationSec: 1.2,
          payloadSummary: 'AMQP Publish',
        },
        {
          id: 'bat-mq-w1',
          from: 'mq',
          to: 'w1',
          protocol: 'amqp',
          color: PROTOCOL_COLORS.amqp,
          label: 'Deliver (prefetch=1)',
          durationSec: 1.3,
          payloadSummary: 'AMQP Deliver',
        },
        {
          id: 'bat-mq-w2',
          from: 'mq',
          to: 'w2',
          protocol: 'amqp',
          color: PROTOCOL_COLORS.amqp,
          label: 'Deliver (prefetch=1)',
          durationSec: 1.3,
          payloadSummary: 'AMQP Deliver',
        },
        {
          id: 'bat-w1-rs',
          from: 'w1',
          to: 'rs',
          protocol: 'rest',
          color: PROTOCOL_COLORS.rest,
          label: 'Claim / Complete',
          durationSec: 1.4,
          payloadSummary: 'Worker Claim/Heartbeat/Complete',
        },
        {
          id: 'bat-w2-rs',
          from: 'w2',
          to: 'rs',
          protocol: 'rest',
          color: PROTOCOL_COLORS.rest,
          label: 'Claim / Complete',
          durationSec: 1.4,
          payloadSummary: 'Worker Claim/Heartbeat/Complete',
        },
        {
          id: 'bat-w1-sock',
          from: 'w1',
          to: 'docker',
          protocol: 'sock',
          color: PROTOCOL_COLORS.sock,
          label: 'Docker Socket API',
          durationSec: 1.2,
          payloadSummary: 'Create/Start/Wait/Delete',
        },
        {
          id: 'bat-w2-sock',
          from: 'w2',
          to: 'docker',
          protocol: 'sock',
          color: PROTOCOL_COLORS.sock,
          label: 'Docker Socket API',
          durationSec: 1.2,
          payloadSummary: 'Create/Start/Wait/Delete',
        },
      )
    }

    this.activePdus = pdus
  }

  private buildSpecsForSuite(suiteId: BatteryId): BatteryCaseSpec[] {
    if (suiteId === 'smoke') {
      return [
        {
          label: 'Python stdin',
          shortLang: 'Python',
          language: 'python',
          sourceCode: `nome = input()\nprint("Olá,", nome)`,
          stdin: 'João\n',
          expectStatus: 'SUCCEEDED',
        },
        {
          label: 'JavaScript',
          shortLang: 'Node',
          language: 'javascript',
          sourceCode: `console.log("Hello, World!");`,
          stdin: '',
          expectStatus: 'SUCCEEDED',
        },
        {
          label: 'Java',
          shortLang: 'Java',
          language: 'java',
          sourceCode: `public class Main { public static void main(String[] args) { System.out.println("Hello, World!"); } }`,
          stdin: '',
          expectStatus: 'SUCCEEDED',
        },
        {
          label: 'C++',
          shortLang: 'C++',
          language: 'cpp',
          sourceCode: `#include <iostream>\nint main() { std::cout << "Hello, World!" << std::endl; return 0; }`,
          stdin: '',
          expectStatus: 'SUCCEEDED',
        },
        {
          label: 'Java compile error',
          shortLang: 'Java Err',
          language: 'java',
          sourceCode: `public class Main { public static void main(String[] args) { System.out.println("erro") } }`,
          stdin: '',
          expectStatus: 'FAILED',
          expectReason: 'COMPILE_ERROR',
        },
        {
          label: 'C++ compile error',
          shortLang: 'C++ Err',
          language: 'cpp',
          sourceCode: `#include <iostream>\nint main() { std::cout << "erro" << std::endl return 0; }`,
          stdin: '',
          expectStatus: 'FAILED',
          expectReason: 'COMPILE_ERROR',
        },
        {
          label: 'Python runtime error',
          shortLang: 'Py Err',
          language: 'python',
          sourceCode: `raise RuntimeError("falha de teste")`,
          stdin: '',
          expectStatus: 'FAILED',
          expectReason: 'RUNTIME_ERROR',
        },
        {
          label: 'Python OOM 256MB',
          shortLang: 'Py OOM',
          language: 'python',
          sourceCode: `data = []\nwhile True:\n    data.append(bytearray(8 * 1024 * 1024))`,
          stdin: '',
          expectStatus: 'FAILED',
          expectReason: 'MEMORY_LIMIT',
        },
        {
          label: 'Python truncation >64KB',
          shortLang: 'Py 80KB',
          language: 'python',
          sourceCode: `print("A" * 80000)`,
          stdin: '',
          expectStatus: 'SUCCEEDED',
        },
        {
          label: 'Python timeout 10s',
          shortLang: 'Py Loop',
          language: 'python',
          sourceCode: `while True:\n    pass`,
          stdin: '',
          expectStatus: 'TIMEOUT',
          expectReason: 'TIMEOUT',
        },
      ]
    }

    if (suiteId === 'burst') {
      const langs: Array<{ l: LanguageId; s: string; code: (i: number) => string }> = [
        {
          l: 'python',
          s: 'Python',
          code: (i) => `import time\ntime.sleep(0.35)\nprint("burst-py-${i}")`,
        },
        {
          l: 'javascript',
          s: 'Node',
          code: (i) =>
            `setTimeout(() => console.log("burst-js-${i}"), 350);`,
        },
        {
          l: 'java',
          s: 'Java',
          code: (i) =>
            `public class Main { public static void main(String[] args) throws Exception { Thread.sleep(250); System.out.println("burst-java-${i}"); } }`,
        },
        {
          l: 'cpp',
          s: 'C++',
          code: (i) =>
            `#include <iostream>\nint main() { std::cout << "burst-cpp-${i}" << std::endl; return 0; }`,
        },
      ]
      return Array.from({ length: 24 }, (_, idx) => {
        const item = langs[idx % langs.length]
        return {
          label: `Burst #${idx + 1}`,
          shortLang: item.s,
          language: item.l,
          sourceCode: item.code(idx + 1),
          stdin: '',
          expectStatus: 'SUCCEEDED',
        }
      })
    }

    if (suiteId === 'drop') {
      return [
        {
          label: 'Payload >64KB (HTTP 400)',
          shortLang: '>64KB',
          language: 'python',
          sourceCode: `# Payload excedendo 64 KiB\nx = "${'A'.repeat(68 * 1024)}"`,
          stdin: '',
        },
        {
          label: 'Client Abort Mid-Polling #1',
          shortLang: 'Abort',
          language: 'python',
          sourceCode: `import time\ntime.sleep(2.5)\nprint("abort-1")`,
          stdin: '',
          abortAfterMs: 450,
        },
        {
          label: 'Valid Python Check',
          shortLang: 'Python',
          language: 'python',
          sourceCode: `print("cliente íntegro #1")`,
          stdin: '',
          expectStatus: 'SUCCEEDED',
        },
        {
          label: 'Payload >64KB (HTTP 400) #2',
          shortLang: '>64KB',
          language: 'javascript',
          sourceCode: `const big = "${'B'.repeat(68 * 1024)}";`,
          stdin: '',
        },
        {
          label: 'Client Abort Mid-Polling #2',
          shortLang: 'Abort',
          language: 'python',
          sourceCode: `import time\ntime.sleep(2.5)\nprint("abort-2")`,
          stdin: '',
          abortAfterMs: 600,
        },
        {
          label: 'Valid Node.js Check',
          shortLang: 'Node',
          language: 'javascript',
          sourceCode: `console.log("cliente íntegro #2");`,
          stdin: '',
          expectStatus: 'SUCCEEDED',
        },
      ]
    }

    // hostile (c=10: mix de OOM bombs, loops infinitos de 10s, compile error e jobs válidos)
    return [
      {
        label: 'Valid Python #1',
        shortLang: 'Python',
        language: 'python',
        sourceCode: `print("hostile-ok-1")`,
        stdin: '',
        expectStatus: 'SUCCEEDED',
      },
      {
        label: 'OOM Bomb #1 (256MB)',
        shortLang: 'OOM 137',
        language: 'python',
        sourceCode: `data = []\nwhile True:\n    data.append(bytearray(8 * 1024 * 1024))`,
        stdin: '',
        expectStatus: 'FAILED',
        expectReason: 'MEMORY_LIMIT',
      },
      {
        label: 'Valid Node #2',
        shortLang: 'Node',
        language: 'javascript',
        sourceCode: `console.log("hostile-ok-2");`,
        stdin: '',
        expectStatus: 'SUCCEEDED',
      },
      {
        label: 'Java Compile Error',
        shortLang: 'Java Err',
        language: 'java',
        sourceCode: `public class Main { public static void main(String[] args) { System.out.println("erro") } }`,
        stdin: '',
        expectStatus: 'FAILED',
        expectReason: 'COMPILE_ERROR',
      },
      {
        label: 'Valid Java #3',
        shortLang: 'Java',
        language: 'java',
        sourceCode: `public class Main { public static void main(String[] args) { System.out.println("hostile-ok-3"); } }`,
        stdin: '',
        expectStatus: 'SUCCEEDED',
      },
      {
        label: 'OOM Bomb #2 (C++)',
        shortLang: 'C++ OOM',
        language: 'cpp',
        sourceCode: `#include <vector>\n#include <cstring>\nint main() { std::vector<char*> v; while(true) { char* p = new char[8*1024*1024]; std::memset(p, 1, 8*1024*1024); v.push_back(p); } }`,
        stdin: '',
        expectStatus: 'FAILED',
        expectReason: 'MEMORY_LIMIT',
      },
      {
        label: 'Valid C++ #4',
        shortLang: 'C++',
        language: 'cpp',
        sourceCode: `#include <iostream>\nint main() { std::cout << "hostile-ok-4" << std::endl; return 0; }`,
        stdin: '',
        expectStatus: 'SUCCEEDED',
      },
      {
        label: 'Output Flood 80KB',
        shortLang: 'Flood',
        language: 'python',
        sourceCode: `print("X" * 80000)`,
        stdin: '',
        expectStatus: 'SUCCEEDED',
      },
      {
        label: 'Valid Python #5',
        shortLang: 'Python',
        language: 'python',
        sourceCode: `print("hostile-ok-5")`,
        stdin: '',
        expectStatus: 'SUCCEEDED',
      },
      {
        label: 'Infinite Loop (Kill 10s)',
        shortLang: 'Loop 10s',
        language: 'python',
        sourceCode: `while True:\n    pass`,
        stdin: '',
        expectStatus: 'TIMEOUT',
        expectReason: 'TIMEOUT',
      },
    ]
  }
}
