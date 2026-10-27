import type {
  ActivePduEnvelope,
  ChaosState,
  ClientVisualStatus,
  PostgresJobRow,
  ProtocolType,
  SingleJobConfig,
  StepXRayInspector,
} from '../../src/shared/protocol.ts'
import type { ExecutionPresetResult } from './codePresets.ts'

export const PROTOCOL_COLORS: Record<ProtocolType, string> = {
  http: '#22d3ee',
  rest: '#a78bfa',
  amqp: '#fb923c',
  sql: '#34d399',
  sock: '#facc15',
}

export interface RealExecutionTrace {
  pgRow: PostgresJobRow | null
  realContainerName: string | null
  ingestMs: number | null
  queueMs: number | null
  execMs: number | null
  httpStatus: number | null
  errorDetail: string | null
}

export function getStepLabels(
  routedApi: 'api1' | 'api2' = 'api1',
  assignedWorker: 'w1' | 'w2' = 'w1',
): string[] {
  const apiName = routedApi === 'api1' ? 'api-1' : 'api-2'
  const workerName = assignedWorker === 'w1' ? 'worker-1' : 'worker-2'
  return [
    'HTTP POST /api/jobs',
    `Nginx least_conn → ${apiName}`,
    `Submission API validate (≤64KB)`,
    'ResultService SQL INSERT QUEUED',
    'RabbitMQ Publish + Confirm',
    'HTTP 202 Accepted',
    `${workerName} basic.consume (prefetch=1)`,
    `${workerName} Claim + LeaseToken (20s)`,
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
}

export interface EvaluatedStepDetails {
  xray: StepXRayInspector
  activePdus: ActivePduEnvelope[]
  clientStatus: ClientVisualStatus
  pgJobRow: PostgresJobRow | null
  sandboxSlotActive: boolean
  sandboxSlotStatus: 'FREE' | 'CREATING' | 'RUNNING' | 'KILLING' | 'CLEANUP'
  workerDockerStep: string
  workerLeaseRemainingSec: number
  workerHeartbeatActive: boolean
  rabbitReadyCount: number
  rabbitUnackedCount: number
  resultServiceLastOp: string
}

export function evaluateSingleJobStep(
  stepIndex: number,
  job: SingleJobConfig,
  preset: ExecutionPresetResult,
  chaos: ChaosState,
  realTrace?: RealExecutionTrace,
): EvaluatedStepDetails {
  const step = Math.max(0, Math.min(21, stepIndex))
  const realRow = realTrace?.pgRow ?? null

  // Usa dados reais do PostgreSQL/Docker quando disponíveis
  const realWorkerId = realRow?.worker_id
  const activeWorkerNode: 'w1' | 'w2' =
    realWorkerId === 'worker-2'
      ? 'w2'
      : realWorkerId === 'worker-1'
        ? 'w1'
        : chaos.w1 && step >= 8
          ? 'w2'
          : job.assignedWorker

  const workerName = activeWorkerNode === 'w1' ? 'worker-1' : 'worker-2'
  const labels = getStepLabels(job.routedApi, activeWorkerNode)
  const shortJobId = `${job.activeJobId.slice(0, 8)}…${job.activeJobId.slice(-4)}`

  const fullContainerName =
    realTrace?.realContainerName ||
    `dockercode-${job.activeJobId.replace(/-/g, '')}-${job.activeJobId.slice(-6)}`
  const containerSuffix = fullContainerName.slice(-6)
  const shortContainerName = `dockercode-${job.activeJobId.slice(0, 8)}-${containerSuffix}`

  const apiNode = job.routedApi
  const apiName = apiNode === 'api1' ? 'submission-api-1' : 'submission-api-2'
  const clientNodeId = job.clientId || 'client-01'

  const leaseToken =
    realRow?.lease_token ||
    (chaos.w1 && step >= 8
      ? 'd92a-77c4-41e0-88b12345f902'
      : 'b91e-44d2-8a11-9c04f1e2a3b4')

  const attemptCount =
    realRow?.attempt_count && realRow.attempt_count > 0
      ? realRow.attempt_count
      : chaos.w1 && step >= 8
        ? 2
        : 1

  const finalStatus =
    realRow &&
    (realRow.status === 'SUCCEEDED' ||
      realRow.status === 'FAILED' ||
      realRow.status === 'TIMEOUT')
      ? realRow.status
      : preset.finalStatus

  const stdoutText =
    realRow && realRow.stdout !== null
      ? realRow.stdout.trimEnd()
      : preset.buildStdout(job.stdin).trimEnd()

  const stderrText =
    realRow && realRow.stderr !== null ? realRow.stderr : preset.stderr

  const exitCodeVal =
    realRow && realRow.exit_code !== null
      ? realRow.exit_code
      : preset.exitCode

  const failureReasonVal =
    realRow && realRow.failure_reason !== undefined
      ? realRow.failure_reason
      : preset.failureReason

  const execTimeMs = realTrace?.execMs ?? preset.execTimeMs
  const ingestMs = realTrace?.ingestMs ?? 14
  const isOom =
    failureReasonVal === 'MEMORY_LIMIT' ||
    exitCodeVal === 137 ||
    preset.oomKilled
  const isTimeout = finalStatus === 'TIMEOUT' || preset.timedOut

  const byteSizeCode = Buffer.byteLength(job.sourceCode, 'utf8')
  const byteSizeStdin = Buffer.byteLength(job.stdin, 'utf8')
  const nowIso = new Date().toISOString()

  type StepMeta = {
    protocol: ProtocolType
    from: string
    to: string
    pduLabel: string
    lastOp: string
    dockerStep: string
    jsonPayload: string
  }

  const stepMetas: StepMeta[] = [
    // 0: HTTP POST /api/jobs
    {
      protocol: 'http',
      from: clientNodeId,
      to: 'ngx',
      pduLabel: 'POST /api/jobs',
      lastOp: 'IDLE',
      dockerStep: 'IDLE',
      jsonPayload:
        `POST http://localhost:8080/api/jobs HTTP/1.1\nContent-Type: application/json\nX-Correlation-ID: ${job.correlationId}\n\n` +
        JSON.stringify(
          {
            language: job.language,
            sourceCode: job.sourceCode,
            stdin: job.stdin,
          },
          null,
          2,
        ),
    },
    // 1: Nginx least_conn -> api
    {
      protocol: 'http',
      from: 'ngx',
      to: apiNode,
      pduLabel: `Proxy → ${apiName}`,
      lastOp: 'IDLE',
      dockerStep: 'IDLE',
      jsonPayload:
        `# Nginx Reverse Proxy (:8080 -> ${apiName}:8080 | least_conn)\nPOST /api/jobs HTTP/1.1\nX-Real-IP: 172.18.0.1\nX-Correlation-ID: ${job.correlationId}\nContent-Length: ${byteSizeCode + byteSizeStdin + 48} bytes`,
    },
    // 2: Submission API validate
    {
      protocol: 'rest',
      from: apiNode,
      to: apiNode,
      pduLabel: 'Validate Payload',
      lastOp: 'VALIDATE_OK',
      dockerStep: 'IDLE',
      jsonPayload:
        `# Validação real em SubmissionApi/Program.cs:\n✓ language: "${job.language}" ∈ {python, javascript, java, cpp}\n✓ sourceCode UTF-8: ${byteSizeCode} bytes (≤ 65536 bytes / 64 KiB)\n✓ stdin UTF-8: ${byteSizeStdin} bytes (≤ 32768 bytes / 32 KiB)\n✓ correlation_id: "${job.correlationId}"`,
    },
    // 3: ResultService SQL INSERT QUEUED
    {
      protocol: 'sql',
      from: 'rs',
      to: 'pg',
      pduLabel: 'INSERT QUEUED',
      lastOp: 'POST /internal/jobs',
      dockerStep: 'IDLE',
      jsonPayload:
        `POST http://result-service:8080/internal/jobs\n{\n  "language": "${job.language}",\n  "correlationId": "${job.correlationId}"\n}\n--- SQL Real Executado (PostgreSQL :5432) ---\nINSERT INTO jobs(id, language, source_code, stdin, status, created_at, correlation_id)\nVALUES ('${job.activeJobId}', '${job.language}', $1, $2, 'QUEUED', '${realRow?.created_at ?? nowIso}', '${job.correlationId}');`,
    },
    // 4: RabbitMQ Publish + Confirm
    {
      protocol: 'amqp',
      from: apiNode,
      to: 'mq',
      pduLabel: chaos.mq ? 'Publish FAILED (503)' : 'BasicPublish + Confirm',
      lastOp: chaos.mq ? 'POST /mark-failed (BROKER_UNAVAILABLE)' : 'POST /internal/jobs',
      dockerStep: 'IDLE',
      jsonPayload: chaos.mq
        ? `❌ ERRO AMQP: Broker RabbitMQ indisponível!\nFallback acionado por ${apiName}:\nPOST /internal/jobs/${job.activeJobId}/mark-failed\n{ "failureReason": "BROKER_UNAVAILABLE", "stderr": "Não foi possível encaminhar o Job para execução." }\nRetorno HTTP ao cliente: 503 Service Unavailable`
        : `AMQP 0-9-1 BasicPublish (Queue: "execution.jobs", Durable: true)\nProperties: { Persistent: true, ContentType: "application/json", MessageId: "${job.activeJobId}", CorrelationId: "${job.correlationId}" }\nPayload: { "JobId": "${job.activeJobId}", "CorrelationId": "${job.correlationId}" }\nWaitForConfirmsOrDie(5s): Confirmado pelo RabbitMQ`,
    },
    // 5: HTTP 202 Accepted
    {
      protocol: 'http',
      from: apiNode,
      to: 'ngx',
      pduLabel: chaos.mq ? 'HTTP 503 Unavailable' : `HTTP 202 (${ingestMs}ms)`,
      lastOp: 'POST /internal/jobs',
      dockerStep: 'IDLE',
      jsonPayload: chaos.mq
        ? `HTTP/1.1 503 Service Unavailable\nContent-Type: application/problem+json\n\n{\n  "status": 503,\n  "title": "Fila de execução indisponível",\n  "detail": "${realTrace?.errorDetail ?? 'Não foi possível encaminhar a execução.'}"\n}`
        : `HTTP/1.1 202 Accepted (Latência Ingestão: ${ingestMs}ms)\nLocation: /api/jobs/${job.activeJobId}\nX-Correlation-ID: ${job.correlationId}\nContent-Type: application/json\n\n{\n  "jobId": "${job.activeJobId}",\n  "status": "QUEUED"\n}`,
    },
    // 6: Worker basic.consume
    {
      protocol: 'amqp',
      from: 'mq',
      to: activeWorkerNode,
      pduLabel: 'BasicDeliver (prefetch=1)',
      lastOp: 'POST /internal/jobs',
      dockerStep: 'AMQP_CONSUMED',
      jsonPayload:
        `AMQP BasicDeliver → ${workerName}\nQueue: "execution.jobs" | BasicQos(prefetchSize: 0, prefetchCount: 1, global: false)\nAutoAck: false\nBody: {\n  "JobId": "${job.activeJobId}",\n  "CorrelationId": "${job.correlationId}"\n}`,
    },
    // 7: Worker Claim + LeaseToken
    {
      protocol: 'rest',
      from: activeWorkerNode,
      to: 'rs',
      pduLabel: 'POST /claim (Lease 20s)',
      lastOp: 'POST /internal/jobs/{id}/claim',
      dockerStep: 'CLAIM_ACQUIRED',
      jsonPayload:
        `POST http://result-service:8080/internal/jobs/${job.activeJobId}/claim\nRequest: { "workerId": "${workerName}", "leaseSeconds": 20 }\n\nSQL Atomic Claim Real:\nUPDATE jobs SET status='RUNNING', worker_id='${workerName}', lease_token='${leaseToken}', lease_until=NOW()+INTERVAL '20s', attempt_count=${attemptCount}\nWHERE id='${job.activeJobId}' AND attempt_count < 3\nRETURNING status, language, source_code, stdin, lease_token;`,
    },
    // 8: Heartbeat start (5s)
    {
      protocol: 'rest',
      from: activeWorkerNode,
      to: 'rs',
      pduLabel: 'POST /heartbeat (5s)',
      lastOp: 'POST /internal/jobs/{id}/heartbeat',
      dockerStep: 'HEARTBEAT_ACTIVE',
      jsonPayload:
        (attemptCount > 1
          ? `⚠️ Lease anterior expirou! ${workerName} assumiu na tentativa #${attemptCount} com novo lease_token = ${leaseToken}\n\n`
          : '') +
        `POST http://result-service:8080/internal/jobs/${job.activeJobId}/heartbeat\n{\n  "workerId": "${workerName}",\n  "leaseToken": "${leaseToken}",\n  "leaseSeconds": 20\n}\nResponse: 204 No Content (lease_until renovado para +20s)`,
    },
    // 9: Docker Create Volume tmpfs
    {
      protocol: 'sock',
      from: activeWorkerNode,
      to: 'docker',
      pduLabel: 'POST /volumes/create',
      lastOp: 'POST /internal/jobs/{id}/heartbeat',
      dockerStep: 'CREATE_VOLUME_TMPFS',
      jsonPayload:
        `POST http://docker/volumes/create (via /var/run/docker.sock)\n{\n  "Name": "${fullContainerName}",\n  "Driver": "local",\n  "DriverOpts": {\n    "type": "tmpfs",\n    "device": "tmpfs",\n    "o": "size=32m,exec,nosuid,nodev,uid=10001,gid=10001,mode=0700"\n  }\n}`,
    },
    // 10: Docker Create Container
    {
      protocol: 'sock',
      from: activeWorkerNode,
      to: 'docker',
      pduLabel: 'POST /containers/create',
      lastOp: 'POST /internal/jobs/{id}/heartbeat',
      dockerStep: 'CREATE_CONTAINER',
      jsonPayload:
        `POST http://docker/containers/create?name=${fullContainerName}\n{\n  "Image": "${preset.image}",\n  "User": "10001:10001",\n  "WorkingDir": "/workspace",\n  "Cmd": ["sh", "-c", "while [ ! -f /workspace/.ready ]; do sleep 0.05; done; ${preset.command}"],\n  "HostConfig": {\n    "NetworkMode": "none",\n    "ReadonlyRootfs": true,\n    "Memory": 268435456,\n    "NanoCpus": 1000000000,\n    "PidsLimit": 64,\n    "CapDrop": ["ALL"],\n    "SecurityOpt": ["no-new-privileges"],\n    "Binds": ["${fullContainerName}:/workspace"]\n  }\n}`,
    },
    // 11: Container Start
    {
      protocol: 'sock',
      from: activeWorkerNode,
      to: 'docker',
      pduLabel: 'POST /containers/start',
      lastOp: 'POST /internal/jobs/{id}/heartbeat',
      dockerStep: 'START_CONTAINER',
      jsonPayload:
        `POST http://docker/containers/${fullContainerName}/start\nResponse: 204 No Content\n\n# Container real iniciado no Docker Host:\nAguardando arquivo sentinela /workspace/.ready antes de disparar o compilador/interpretador.`,
    },
    // 12: PutArchive .tar
    {
      protocol: 'sock',
      from: activeWorkerNode,
      to: 'docker',
      pduLabel: 'PUT /archive (.tar)',
      lastOp: 'POST /internal/jobs/{id}/heartbeat',
      dockerStep: 'PUT_ARCHIVE_TAR',
      jsonPayload:
        `PUT http://docker/containers/${fullContainerName}/archive?path=%2Fworkspace\nContent-Type: application/x-tar\n\nEntradas enviadas pelo TarArchiveHelper:\n1. "${preset.sourceFileName}" (${byteSizeCode} bytes)\n2. "stdin.txt" (${byteSizeStdin} bytes)\n3. ".ready" (0 bytes -> libera barreira de execução)`,
    },
    // 13: Wait (timeout 10s)
    {
      protocol: 'sock',
      from: activeWorkerNode,
      to: 'docker',
      pduLabel: isTimeout ? 'WAIT 10s → POST /kill' : 'POST /containers/wait',
      lastOp: 'POST /internal/jobs/{id}/heartbeat',
      dockerStep: isTimeout ? 'KILL_TIMEOUT_10S' : 'WAIT_CONTAINER',
      jsonPayload: isTimeout
        ? `POST http://docker/containers/${fullContainerName}/wait?condition=not-running\n⏱ CancellationTokenSource expirou após 10.0s (Sandbox:TimeoutSeconds = 10)!\n\nAcionado imediatamente:\nPOST http://docker/containers/${fullContainerName}/kill (SIGKILL)\nStatus classificado: TIMEOUT (failureReason = "TIMEOUT")`
        : `POST http://docker/containers/${fullContainerName}/wait?condition=not-running\nTimeout configurado: 10.0s\n\nResponse Real (após ${execTimeMs}ms):\n{\n  "StatusCode": ${exitCodeVal ?? 0}\n}`,
    },
    // 14: Logs stdout/stderr & Inspect
    {
      protocol: 'sock',
      from: activeWorkerNode,
      to: 'docker',
      pduLabel: 'GET /logs & /json',
      lastOp: 'POST /internal/jobs/{id}/heartbeat',
      dockerStep: 'GET_LOGS_AND_INSPECT',
      jsonPayload:
        `GET http://docker/containers/${fullContainerName}/logs?stdout=true&stderr=true\nDemux binário (frames de 8 bytes: [streamType, 0, 0, 0, lenBigEndian32])\n\nGET http://docker/containers/${fullContainerName}/json\nState: {\n  "ExitCode": ${exitCodeVal ?? 'null'},\n  "OOMKilled": ${isOom}\n}\nClassificação Real do Worker: status="${finalStatus}", failureReason=${JSON.stringify(failureReasonVal)}`,
    },
    // 15: Delete Container
    {
      protocol: 'sock',
      from: activeWorkerNode,
      to: 'docker',
      pduLabel: 'DELETE /containers/{id}',
      lastOp: 'POST /internal/jobs/{id}/heartbeat',
      dockerStep: 'DELETE_CONTAINER',
      jsonPayload:
        `# Bloco finally em DockerEngineClient.cs:\nDELETE http://docker/containers/${fullContainerName}?force=true&v=true\nResponse: 204 No Content\n\n✓ Container efêmero ${shortContainerName} removido no Docker Engine.`,
    },
    // 16: Delete Volume
    {
      protocol: 'sock',
      from: activeWorkerNode,
      to: 'docker',
      pduLabel: 'DELETE /volumes/{name}',
      lastOp: 'POST /internal/jobs/{id}/heartbeat',
      dockerStep: 'DELETE_VOLUME',
      jsonPayload:
        `# Bloco finally em DockerEngineClient.cs:\nDELETE http://docker/volumes/${fullContainerName}?force=true\nResponse: 204 No Content\n\n✓ Volume tmpfs em RAM (/workspace 32MB) destruído.\n✓ Auditoria Docker Host: 0 containers órfãos | 0 volumes órfãos.`,
    },
    // 17: Persist result (SQL UPDATE)
    {
      protocol: 'rest',
      from: activeWorkerNode,
      to: 'rs',
      pduLabel: `POST /complete (${finalStatus})`,
      lastOp: 'POST /internal/jobs/{id}/complete',
      dockerStep: 'IDLE',
      jsonPayload:
        `POST http://result-service:8080/internal/jobs/${job.activeJobId}/complete\n` +
        JSON.stringify(
          {
            workerId: workerName,
            leaseToken,
            status: finalStatus,
            stdout: stdoutText,
            stderr: stderrText,
            exitCode: exitCodeVal,
            failureReason: failureReasonVal,
          },
          null,
          2,
        ) +
        `\n\nSQL Guard: WHERE id='${job.activeJobId}' AND status='RUNNING' AND worker_id='${workerName}' AND lease_token='${leaseToken}'`,
    },
    // 18: BasicAck
    {
      protocol: 'amqp',
      from: activeWorkerNode,
      to: 'mq',
      pduLabel: 'AMQP BasicAck',
      lastOp: 'POST /internal/jobs/{id}/complete',
      dockerStep: 'IDLE',
      jsonPayload:
        `AMQP BasicAck (DeliveryTag: 1, Multiple: false)\nWorker: ${workerName} → Queue: "execution.jobs"\n\n✓ Mensagem confirmada e removida definitivamente da fila durável do RabbitMQ.`,
    },
    // 19: Lease release & stop heartbeat
    {
      protocol: 'rest',
      from: activeWorkerNode,
      to: activeWorkerNode,
      pduLabel: 'Cancel Heartbeat CTS',
      lastOp: 'POST /internal/jobs/{id}/complete',
      dockerStep: 'IDLE',
      jsonPayload:
        `# Bloco finally em JobConsumer.cs:\nheartbeatCts.Cancel();\nawait heartbeatTask;\n\n✓ Loop de Heartbeat (5s) encerrado no ${workerName}.\n✓ Coluna lease_until limpa (NULL) no PostgreSQL.\n✓ ${workerName} livre para o próximo Job (prefetch=1).`,
    },
    // 20: Polling GET 750ms
    {
      protocol: 'http',
      from: clientNodeId,
      to: 'ngx',
      pduLabel: 'GET /api/jobs/{id}',
      lastOp: 'GET /internal/jobs/{id}',
      dockerStep: 'IDLE',
      jsonPayload:
        `GET http://localhost:8080/api/jobs/${job.activeJobId} HTTP/1.1\n\n# Fluxo real da consulta:\n${job.clientLabel || 'Client'} → Nginx (:8080) → ${apiName} → ResultService (/internal/jobs/${shortJobId}) → PostgreSQL SELECT`,
    },
    // 21: 200 OK DONE
    {
      protocol: 'http',
      from: 'ngx',
      to: clientNodeId,
      pduLabel: `200 OK (${finalStatus})`,
      lastOp: 'GET /internal/jobs/{id}',
      dockerStep: 'IDLE',
      jsonPayload:
        `HTTP/1.1 200 OK\nContent-Type: application/json\n\n` +
        JSON.stringify(
          {
            jobId: job.activeJobId,
            status: finalStatus,
            stdout: stdoutText,
            stderr: stderrText,
            exitCode: exitCodeVal,
            failureReason: failureReasonVal,
            createdAt: realRow?.created_at ?? nowIso,
            startedAt: realRow?.started_at ?? nowIso,
            finishedAt: realRow?.finished_at ?? nowIso,
          },
          null,
          2,
        ),
    },
  ]

  const meta = stepMetas[step]

  // Linha do PostgreSQL real/contextualizada para o passo
  let pgRowText = ''
  let pgJobRow: PostgresJobRow | null = realRow

  if (step < 3) {
    pgRowText =
      `[Tabela jobs — PostgreSQL 16 :5432]\n` +
      `Ainda não inserido neste passo (${step + 1}/22: ${labels[step]}).\n` +
      `O INSERT ocorre no Passo 04 via POST /internal/jobs.`
  } else if (chaos.mq && step >= 4) {
    pgRowText =
      `id: ${job.activeJobId}\n` +
      `status: FAILED   failure_reason: BROKER_UNAVAILABLE\n` +
      `lease_token: NULL   attempt_count: 0   worker_id: NULL\n` +
      `stderr: "Não foi possível encaminhar o Job para execução."`
  } else if (step >= 3 && step <= 6) {
    pgRowText =
      `id: ${job.activeJobId}\n` +
      `status: QUEUED   language: ${job.language}\n` +
      `lease_token: NULL   lease_until: NULL\n` +
      `attempt_count: 0    worker_id: NULL   correlation_id: ${job.correlationId}`
  } else if (step >= 7 && step <= 16) {
    const remainingLease =
      realRow?.status === 'RUNNING' && realRow.lease_remaining_sec
        ? realRow.lease_remaining_sec
        : step === 8
          ? 20
          : Math.max(14, 20 - (step - 7))
    pgRowText =
      `id: ${job.activeJobId}   status: RUNNING\n` +
      `worker_id: ${workerName}   attempt_count: ${attemptCount}\n` +
      `lease_token: ${leaseToken}\n` +
      `lease_until: now()+${remainingLease}s (${realRow?.lease_until ?? 'ativo'})`
  } else {
    pgRowText =
      `id: ${job.activeJobId}   status: ${finalStatus}\n` +
      `worker_id: ${workerName}   attempt_count: ${attemptCount}\n` +
      `lease_token: ${leaseToken}   lease_until: NULL\n` +
      `exit_code: ${exitCodeVal ?? 'NULL'}   failure_reason: ${failureReasonVal ?? 'NULL'}`
  }

  // Sandbox & Output real/contextualizado
  let sandboxOutputText = ''
  if (step < 9) {
    sandboxOutputText =
      `[Docker Engine /var/run/docker.sock]\n` +
      `Sandbox aguardando provisionamento (passo ${step + 1}/22).\n` +
      `Container real alvo: ${shortContainerName} (${preset.image})\n` +
      `Isolamento: 256MB RAM | 1.0 vCPU | 64 PIDs | net: none | ro-rootfs`
  } else if (step === 9) {
    sandboxOutputText =
      `volume: ${fullContainerName}\n` +
      `driver: local (type=tmpfs, size=32m, exec, nosuid, nodev, uid=10001, mode=0700)\n` +
      `status: Volume tmpfs montado em RAM pronto para /workspace`
  } else if (step >= 10 && step <= 12) {
    sandboxOutputText =
      `container: ${fullContainerName}\n` +
      `image: ${preset.image}  net: none  ro-rootfs: true  memory: 256MB\n` +
      `state: ${step === 10 ? 'CREATED' : step === 11 ? 'RUNNING (aguardando /workspace/.ready)' : 'RUNNING (.tar extraído, .ready liberado)'}\n` +
      `cmd: ${preset.command}`
  } else if (step === 13) {
    sandboxOutputText =
      `container: ${fullContainerName}\n` +
      `image: ${preset.image}  net: none  ro-rootfs: true  timeout: 10s\n` +
      (isTimeout
        ? `⚠️ TIMEOUT 10.0s atingido! Enviando POST /containers/{id}/kill (SIGKILL)...`
        : isOom
          ? `⚠️ Limite de 256MB excedido! OOM Killer acionado (exit 137)...`
          : `Executando no container real (${execTimeMs}ms)...`)
  } else {
    const cleanedNote =
      step >= 16
        ? ' [Destruído: 0 órfãos]'
        : step === 15
          ? ' [Container removido]'
          : ''
    sandboxOutputText =
      `container: ${shortContainerName}${cleanedNote}  net: none  ro-rootfs: true\n` +
      `memory: 256MB  tmpfs: /workspace 32MB  pids: 64  OOMKilled: ${isOom}\n` +
      `stdout: ${JSON.stringify(stdoutText)}\n` +
      `stderr: ${JSON.stringify(stderrText)}   exitCode: ${exitCodeVal ?? 'null'}   time: ${execTimeMs}ms`
  }

  const activePdus: ActivePduEnvelope[] = [
    {
      id: `pdu-step-${step}`,
      from: meta.from,
      to: meta.to,
      protocol: meta.protocol,
      color: PROTOCOL_COLORS[meta.protocol],
      label: meta.pduLabel,
      stepIndex: step,
      jobId: job.activeJobId,
      correlationId: job.correlationId,
      durationSec: 1.3,
      payloadSummary: meta.pduLabel,
    },
  ]

  if (step === 3) {
    activePdus.unshift({
      id: 'pdu-step-3-rest',
      from: apiNode,
      to: 'rs',
      protocol: 'rest',
      color: PROTOCOL_COLORS.rest,
      label: 'POST /internal/jobs',
      stepIndex: step,
      jobId: job.activeJobId,
      correlationId: job.correlationId,
      durationSec: 1.3,
      payloadSummary: 'POST /internal/jobs',
    })
  } else if (step === 7 || step === 17) {
    activePdus.push({
      id: `pdu-step-${step}-sql`,
      from: 'rs',
      to: 'pg',
      protocol: 'sql',
      color: PROTOCOL_COLORS.sql,
      label: step === 7 ? 'UPDATE RUNNING + Lease' : `UPDATE ${finalStatus}`,
      stepIndex: step,
      jobId: job.activeJobId,
      correlationId: job.correlationId,
      durationSec: 1.2,
      payloadSummary: 'UPDATE jobs WHERE id=@id',
    })
  } else if (step === 20) {
    activePdus.push(
      {
        id: 'pdu-step-20-proxy',
        from: 'ngx',
        to: apiNode,
        protocol: 'http',
        color: PROTOCOL_COLORS.http,
        label: 'GET /api/jobs/{id}',
        stepIndex: step,
        durationSec: 1.2,
        payloadSummary: 'GET /api/jobs/{id}',
      },
      {
        id: 'pdu-step-20-rest',
        from: apiNode,
        to: 'rs',
        protocol: 'rest',
        color: PROTOCOL_COLORS.rest,
        label: 'GET /internal/jobs/{id}',
        stepIndex: step,
        durationSec: 1.2,
        payloadSummary: 'GET /internal/jobs/{id}',
      },
    )
  }

  const isTerminalInDb = Boolean(
    realRow &&
      (realRow.status === 'SUCCEEDED' ||
        realRow.status === 'FAILED' ||
        realRow.status === 'TIMEOUT'),
  )

  const clientStatus: ClientVisualStatus =
    chaos.mq && step >= 4
      ? '503 ERROR'
      : step >= 21 || isTerminalInDb
        ? '200 OK'
        : step <= 4
          ? 'SUBMITTING'
          : 'POLLING 750ms'

  const sandboxSlotActive = step >= 9 && step <= 15
  const sandboxSlotStatus: EvaluatedStepDetails['sandboxSlotStatus'] =
    step < 9 || step > 15
      ? 'FREE'
      : step <= 10
        ? 'CREATING'
        : step <= 13
          ? isTimeout && step === 13
            ? 'KILLING'
            : 'RUNNING'
          : 'CLEANUP'

  const workerHeartbeatActive = step >= 8 && step <= 18
  const workerLeaseRemainingSec =
    step < 7
      ? 0
      : step >= 18
        ? 0
        : realRow?.status === 'RUNNING' && realRow.lease_remaining_sec
          ? realRow.lease_remaining_sec
          : step === 8
            ? 20
            : Math.max(14, 20 - (step - 7))

  const rabbitReadyCount = step >= 4 && step <= 5 && !chaos.mq ? 1 : 0
  const rabbitUnackedCount = step >= 6 && step <= 17 && !chaos.mq ? 1 : 0

  return {
    xray: {
      stepIndex: step,
      stepNumber: String(step + 1).padStart(2, '0'),
      title: labels[step],
      protocol: meta.protocol,
      fromNode: meta.from,
      toNode: meta.to,
      jsonPayload: meta.jsonPayload,
      pgRowText,
      sandboxOutputText,
    },
    activePdus,
    clientStatus,
    pgJobRow,
    sandboxSlotActive,
    sandboxSlotStatus,
    workerDockerStep: meta.dockerStep,
    workerLeaseRemainingSec,
    workerHeartbeatActive,
    rabbitReadyCount,
    rabbitUnackedCount,
    resultServiceLastOp: meta.lastOp,
  }
}
