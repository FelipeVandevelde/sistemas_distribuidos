import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChaosKey, ChaosState } from '../../src/shared/protocol.ts'

const execFileAsync = promisify(execFile)

export class ChaosController {
  private state: ChaosState = {
    w1: false,
    mq: false,
    req: false,
    lastChaosEvent: null,
  }

  public getState(): ChaosState {
    return this.state
  }

  public async toggleChaos(
    key: ChaosKey,
    explicitValue?: boolean,
    onAbortActiveRequest?: () => void,
  ): Promise<ChaosState> {
    const nextValue =
      explicitValue !== undefined ? explicitValue : !this.state[key]
    this.state[key] = nextValue

    if (key === 'w1') {
      if (nextValue) {
        this.state.lastChaosEvent =
          'Container dockercode-worker-1-1 parado (docker stop -t 0). Lease de 20s irá expirar no PostgreSQL e worker-2 assumirá com attempt_count = 2!'
        try {
          await execFileAsync(
            'docker',
            ['stop', '-t', '0', 'dockercode-worker-1-1'],
            { timeout: 6000, windowsHide: true },
          )
        } catch {
          // fallback caso container não exista
        }
      } else {
        this.state.lastChaosEvent =
          'Container dockercode-worker-1-1 restaurado (docker start) e reconectado ao RabbitMQ.'
        try {
          await execFileAsync('docker', ['start', 'dockercode-worker-1-1'], {
            timeout: 6000,
            windowsHide: true,
          })
        } catch {
          // ignore
        }
      }
    } else if (key === 'mq') {
      if (nextValue) {
        this.state.lastChaosEvent =
          'Container dockercode-rabbitmq-1 parado (docker stop -t 0). Novas submissões falham no BasicPublish → BROKER_UNAVAILABLE (HTTP 503)!'
        try {
          await execFileAsync(
            'docker',
            ['stop', '-t', '0', 'dockercode-rabbitmq-1'],
            { timeout: 6000, windowsHide: true },
          )
        } catch {
          // ignore
        }
      } else {
        this.state.lastChaosEvent =
          'Container dockercode-rabbitmq-1 iniciado (docker start). Fila execution.jobs online novamente.'
        try {
          await execFileAsync('docker', ['start', 'dockercode-rabbitmq-1'], {
            timeout: 8000,
            windowsHide: true,
          })
        } catch {
          // ignore
        }
      }
    } else if (key === 'req') {
      if (nextValue) {
        this.state.lastChaosEvent =
          'Sinal de Abort disparado: requisição de cliente em voo derrubada (ABORTED).'
        onAbortActiveRequest?.()
      } else {
        this.state.lastChaosEvent = 'Cancelamento de requisições desativado.'
      }
    }

    return this.state
  }
}
