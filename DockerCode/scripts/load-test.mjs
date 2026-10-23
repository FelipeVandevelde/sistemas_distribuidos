import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const baseUrl = (process.env.DOCKERCODE_URL || "http://localhost:8080").replace(/\/$/, "");
const directApiHealthUrl = (process.env.DOCKERCODE_HEALTH_URL || "http://localhost:8081/health").replace(/\/$/, "");
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 250);
const jobDeadlineMs = Number(process.env.JOB_DEADLINE_MS || 120_000);
const reportFile = process.env.LOAD_REPORT_FILE || "";

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "TIMEOUT"]);

const TEMPLATES = {
  python: (id) => ({
    language: "python",
    sourceCode: `nome = input()\nprint("py-${id}:", nome)`,
    stdin: "DockerCode\n",
    expectStatus: "SUCCEEDED",
    expectStdout: `py-${id}: DockerCode`,
  }),
  javascript: (id) => ({
    language: "javascript",
    sourceCode: `console.log("js-${id}");`,
    stdin: "",
    expectStatus: "SUCCEEDED",
    expectStdout: `js-${id}`,
  }),
  java: (id) => ({
    language: "java",
    sourceCode: `public class Main { public static void main(String[] args) { System.out.println("java-${id}"); } }`,
    stdin: "",
    expectStatus: "SUCCEEDED",
    expectStdout: `java-${id}`,
  }),
  cpp: (id) => ({
    language: "cpp",
    sourceCode: `#include <iostream>\nint main() { std::cout << "cpp-${id}" << std::endl; return 0; }`,
    stdin: "",
    expectStatus: "SUCCEEDED",
    expectStdout: `cpp-${id}`,
  }),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

function summarizeSeries(values) {
  if (!values.length) {
    return { min: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    min: Math.round(Math.min(...values)),
    avg: Math.round(sum / values.length),
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.round(Math.max(...values)),
  };
}

async function runJobSpec(spec) {
  const t0 = performance.now();
  let created;

  try {
    const postResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: spec.language,
        sourceCode: spec.sourceCode,
        stdin: spec.stdin,
      }),
    });

    const t1 = performance.now();
    const ingestMs = t1 - t0;

    if (!postResponse.ok) {
      const errorText = await postResponse.text();
      return {
        ok: false,
        infraError: true,
        language: spec.language,
        ingestMs,
        error: `POST ${postResponse.status}: ${errorText}`,
      };
    }

    created = await postResponse.json();
    const deadline = Date.now() + jobDeadlineMs;
    let job = null;

    while (Date.now() < deadline) {
      const getResponse = await fetch(`${baseUrl}/api/jobs/${created.jobId}`);
      if (getResponse.ok) {
        job = await getResponse.json();
        if (TERMINAL_STATUSES.has(job.status)) {
          break;
        }
      }
      await sleep(pollIntervalMs);
    }

    const t2 = performance.now();
    const totalClientMs = t2 - t0;

    if (!job || !TERMINAL_STATUSES.has(job.status)) {
      return {
        ok: false,
        infraError: true,
        jobId: created.jobId,
        language: spec.language,
        ingestMs,
        totalClientMs,
        error: `Timeout aguardando estado terminal (último status=${job?.status ?? "desconhecido"})`,
      };
    }

    const createdAtMs = job.createdAt ? Date.parse(job.createdAt) : NaN;
    const startedAtMs = job.startedAt ? Date.parse(job.startedAt) : NaN;
    const finishedAtMs = job.finishedAt ? Date.parse(job.finishedAt) : NaN;

    const queueMs =
      Number.isFinite(createdAtMs) && Number.isFinite(startedAtMs)
        ? Math.max(0, startedAtMs - createdAtMs)
        : 0;
    const execMs =
      Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
        ? Math.max(0, finishedAtMs - startedAtMs)
        : 0;
    const totalServerMs =
      Number.isFinite(createdAtMs) && Number.isFinite(finishedAtMs)
        ? Math.max(0, finishedAtMs - createdAtMs)
        : totalClientMs;

    const errors = [];
    if (spec.expectStatus && job.status !== spec.expectStatus) {
      errors.push(`status=${job.status} (esperado ${spec.expectStatus})`);
    }
    if (spec.expectReason && job.failureReason !== spec.expectReason) {
      errors.push(`failureReason=${job.failureReason} (esperado ${spec.expectReason})`);
    }
    if (spec.expectStdout && !job.stdout?.includes(spec.expectStdout)) {
      errors.push(`stdout inesperado=${JSON.stringify(job.stdout?.slice(0, 80))}`);
    }

    const infraError = job.failureReason === "INFRA_ERROR" || job.failureReason === "BROKER_UNAVAILABLE";

    return {
      ok: errors.length === 0 && !infraError,
      infraError,
      jobId: created.jobId,
      language: spec.language,
      status: job.status,
      failureReason: job.failureReason,
      ingestMs,
      queueMs,
      execMs,
      totalServerMs,
      totalClientMs,
      error: errors.join(", ") || null,
    };
  } catch (error) {
    return {
      ok: false,
      infraError: true,
      jobId: created?.jobId ?? null,
      language: spec.language,
      ingestMs: performance.now() - t0,
      error: error.message,
    };
  }
}

async function runPhase({ name, concurrency, specs }) {
  console.log(`\n▶ Iniciando ${name} (${specs.length} Jobs, concorrência=${concurrency})...`);
  const phaseStart = performance.now();
  const results = new Array(specs.length);
  let cursor = 0;

  async function workerLoop() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= specs.length) return;
      results[index] = await runJobSpec(specs[index]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, specs.length) }, () => workerLoop());
  await Promise.all(workers);

  const durationSec = (performance.now() - phaseStart) / 1000;
  const okCount = results.filter((r) => r.ok).length;
  const infraFailures = results.filter((r) => r.infraError).length;
  const validTimings = results.filter((r) => typeof r.queueMs === "number");

  const summary = {
    name,
    concurrency,
    totalJobs: specs.length,
    okCount,
    failedCount: specs.length - okCount,
    infraFailures,
    durationSec: Number(durationSec.toFixed(2)),
    throughputJobsPerSec: Number((specs.length / durationSec).toFixed(2)),
    ingest: summarizeSeries(results.map((r) => r.ingestMs).filter(Number.isFinite)),
    queue: summarizeSeries(validTimings.map((r) => r.queueMs)),
    sandbox: summarizeSeries(validTimings.map((r) => r.execMs)),
    turnaround: summarizeSeries(validTimings.map((r) => r.totalServerMs)),
    results,
  };

  console.log(
    `  Concluído em ${summary.durationSec}s | OK: ${okCount}/${specs.length} | Throughput: ${summary.throughputJobsPerSec} jobs/s | Ingestão P95: ${summary.ingest.p95} ms | Fila P95: ${summary.queue.p95} ms | Sandbox P95: ${summary.sandbox.p95} ms`
  );

  for (const failed of results.filter((r) => !r.ok)) {
    console.error(`  [FALHA] Job ${failed.jobId ?? "-"} (${failed.language}): ${failed.error}`);
  }

  return summary;
}

function buildPhase1Specs() {
  const langs = ["python", "javascript", "java", "cpp", "python", "javascript", "java", "cpp"];
  return langs.map((lang, idx) => TEMPLATES[lang](`f1-${idx + 1}`));
}

function buildPhase2Specs() {
  const langs = ["python", "javascript"];
  return Array.from({ length: 10 }, (_, idx) => TEMPLATES[langs[idx % langs.length]](`f2-${idx + 1}`));
}

function buildPhase3Specs() {
  const langs = ["python", "javascript", "java", "cpp"];
  return Array.from({ length: 24 }, (_, idx) => TEMPLATES[langs[idx % langs.length]](`f3-${idx + 1}`));
}

function buildPhase4Specs() {
  return [
    TEMPLATES.python("f4-1"),
    TEMPLATES.javascript("f4-2"),
    TEMPLATES.java("f4-3"),
    TEMPLATES.cpp("f4-4"),
    TEMPLATES.python("f4-5"),
    TEMPLATES.javascript("f4-6"),
    {
      language: "java",
      sourceCode: `public class Main { public static void main(String[] args) { System.out.println("erro") } }`,
      stdin: "",
      expectStatus: "FAILED",
      expectReason: "COMPILE_ERROR",
    },
    {
      language: "python",
      sourceCode: `data = []\nwhile True:\n    data.append(bytearray(8 * 1024 * 1024))`,
      stdin: "",
      expectStatus: "FAILED",
      expectReason: "MEMORY_LIMIT",
    },
    {
      language: "python",
      sourceCode: `print("A" * 80000)`,
      stdin: "",
      expectStatus: "SUCCEEDED",
      expectStdout: "[saída truncada pelo limite do sandbox]",
    },
    {
      language: "python",
      sourceCode: `while True:\n    pass`,
      stdin: "",
      expectStatus: "TIMEOUT",
      expectReason: "TIMEOUT",
    },
  ];
}

async function runAuditPhase() {
  const audit = {
    apiHealthOk: null,
    orphanContainers: null,
    orphanVolumes: null,
  };

  try {
    const response = await fetch(directApiHealthUrl);
    audit.apiHealthOk = response.ok;
  } catch {
    audit.apiHealthOk = null;
  }

  try {
    const { stdout: containersOut } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      "name=dockercode-",
      "--format",
      "{{.Names}}",
    ]);
    const orphanContainers = containersOut
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((name) => /^dockercode-[0-9a-f]{32}-/i.test(name));
    audit.orphanContainers = orphanContainers.length;

    const { stdout: volumesOut } = await execFileAsync("docker", [
      "volume",
      "ls",
      "--filter",
      "name=dockercode-",
      "--format",
      "{{.Name}}",
    ]);
    const orphanVolumes = volumesOut
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((name) => /^dockercode-[0-9a-f]{32}-/i.test(name));
    audit.orphanVolumes = orphanVolumes.length;
  } catch {
    // CLI do Docker pode não estar acessível no host que disparou o teste.
  }

  return audit;
}

function printSummaryTable(phaseSummaries, phase1LanguageStats, audit) {
  console.log("\n====================================================================================================================");
  console.log("                                   RELATÓRIO DE CARGA — DOCKERCODE");
  console.log("====================================================================================================================");

  const rows = phaseSummaries.map((s) => ({
    Fase: s.name,
    Jobs: s.totalJobs,
    OK: s.okCount,
    "Falha Infra": s.infraFailures,
    "Vazão (jobs/s)": s.throughputJobsPerSec,
    "Ingestão P95": `${s.ingest.p95} ms`,
    "Fila P50": `${s.queue.p50} ms`,
    "Fila P95": `${s.queue.p95} ms`,
    "Sandbox P50": `${s.sandbox.p50} ms`,
    "Sandbox P95": `${s.sandbox.p95} ms`,
    "Total P95": `${s.turnaround.p95} ms`,
  }));

  console.table(rows);

  console.log("\n--- Latência de Sandbox por Linguagem (Fase 1 - Baseline sem fila) ---");
  console.table(phase1LanguageStats);

  console.log("\n--- Fase 5: Auditoria de Saúde e Limpeza ---");
  if (audit.apiHealthOk !== null) {
    console.log(`- Health check Submission API (${directApiHealthUrl}): ${audit.apiHealthOk ? "HEALTHY" : "UNHEALTHY"}`);
  }
  if (audit.orphanContainers !== null && audit.orphanVolumes !== null) {
    console.log(`- Containers de sandbox órfãos (dockercode-*): ${audit.orphanContainers}`);
    console.log(`- Volumes tmpfs órfãos (dockercode-*):         ${audit.orphanVolumes}`);
  }
}

async function main() {
  console.log(`Alvo do teste de carga: ${baseUrl}`);

  const phase1 = await runPhase({
    name: "1. Baseline (c=1)",
    concurrency: 1,
    specs: buildPhase1Specs(),
  });

  const phase2 = await runPhase({
    name: "2. Nominal (c=2)",
    concurrency: 2,
    specs: buildPhase2Specs(),
  });

  const phase3 = await runPhase({
    name: "3. Burst (c=24)",
    concurrency: 24,
    specs: buildPhase3Specs(),
  });

  const phase4 = await runPhase({
    name: "4. Workload Hostil (c=10)",
    concurrency: 10,
    specs: buildPhase4Specs(),
  });

  const phaseSummaries = [phase1, phase2, phase3, phase4];

  const phase1LanguageStats = ["python", "javascript", "java", "cpp"].map((lang) => {
    const items = phase1.results.filter((r) => r.language === lang && Number.isFinite(r.execMs));
    const stats = summarizeSeries(items.map((r) => r.execMs));
    return {
      Linguagem: lang,
      Amostras: items.length,
      "Sandbox Média": `${stats.avg} ms`,
      "Sandbox Min": `${stats.min} ms`,
      "Sandbox Max": `${stats.max} ms`,
    };
  });

  const audit = await runAuditPhase();
  printSummaryTable(phaseSummaries, phase1LanguageStats, audit);

  const totalJobs = phaseSummaries.reduce((acc, s) => acc + s.totalJobs, 0);
  const totalOk = phaseSummaries.reduce((acc, s) => acc + s.okCount, 0);
  const totalInfra = phaseSummaries.reduce((acc, s) => acc + s.infraFailures, 0);

  if (reportFile) {
    await writeFile(
      reportFile,
      JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, phaseSummaries, audit }, null, 2),
      "utf8"
    );
    console.log(`\nRelatório JSON salvo em: ${reportFile}`);
  }

  console.log(`\nResultado Global: ${totalOk}/${totalJobs} Jobs validados com sucesso (${totalInfra} INFRA_ERROR).`);

  const hasLeaks = (audit.orphanContainers ?? 0) > 0 || (audit.orphanVolumes ?? 0) > 0;
  if (totalOk !== totalJobs || totalInfra > 0 || hasLeaks) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\nErro fatal no teste de carga: ${error.message}`);
  process.exit(1);
});
