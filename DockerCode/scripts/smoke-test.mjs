const baseUrl = (process.env.DOCKERCODE_URL || "http://localhost:8080").replace(/\/$/, "");

const cases = [
  {
    name: "Python stdin",
    language: "python",
    sourceCode: `nome = input()\nprint("Olá,", nome)`,
    stdin: "João\n",
    expectStatus: "SUCCEEDED",
    expectStdout: "Olá, João",
  },
  {
    name: "JavaScript",
    language: "javascript",
    sourceCode: `console.log("Hello, World!");`,
    stdin: "",
    expectStatus: "SUCCEEDED",
    expectStdout: "Hello, World!",
  },
  {
    name: "Java",
    language: "java",
    sourceCode: `public class Main { public static void main(String[] args) { System.out.println("Hello, World!"); } }`,
    stdin: "",
    expectStatus: "SUCCEEDED",
    expectStdout: "Hello, World!",
  },
  {
    name: "C++",
    language: "cpp",
    sourceCode: `#include <iostream>\nint main() { std::cout << "Hello, World!" << std::endl; return 0; }`,
    stdin: "",
    expectStatus: "SUCCEEDED",
    expectStdout: "Hello, World!",
  },
  {
    name: "Java compile error",
    language: "java",
    sourceCode: `public class Main { public static void main(String[] args) { System.out.println("erro") } }`,
    stdin: "",
    expectStatus: "FAILED",
    expectReason: "COMPILE_ERROR",
  },
  {
    name: "C++ compile error",
    language: "cpp",
    sourceCode: `#include <iostream>\nint main() { std::cout << "erro" << std::endl return 0; }`,
    stdin: "",
    expectStatus: "FAILED",
    expectReason: "COMPILE_ERROR",
  },
  {
    name: "Python runtime error",
    language: "python",
    sourceCode: `raise RuntimeError("falha de teste")`,
    stdin: "",
    expectStatus: "FAILED",
    expectReason: "RUNTIME_ERROR",
  },
  {
    name: "Python memory limit",
    language: "python",
    sourceCode: `data = []\nwhile True:\n    data.append(bytearray(8 * 1024 * 1024))`,
    stdin: "",
    expectStatus: "FAILED",
    expectReason: "MEMORY_LIMIT",
  },
  {
    name: "Python output truncation",
    language: "python",
    sourceCode: `print("A" * 80000)`,
    stdin: "",
    expectStatus: "SUCCEEDED",
    expectStdout: "[saída truncada pelo limite do sandbox]",
  },
  {
    name: "Python timeout",
    language: "python",
    sourceCode: `while True:\n    pass`,
    stdin: "",
    expectStatus: "TIMEOUT",
    expectReason: "TIMEOUT",
  },
];

const terminal = new Set(["SUCCEEDED", "FAILED", "TIMEOUT"]);

async function submit(test) {
  const response = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: test.language,
      sourceCode: test.sourceCode,
      stdin: test.stdin,
    }),
  });

  if (!response.ok) throw new Error(`POST falhou (${response.status}): ${await response.text()}`);
  return response.json();
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    if (!response.ok) throw new Error(`GET falhou (${response.status}): ${await response.text()}`);
    const job = await response.json();
    if (terminal.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Timeout do smoke test aguardando o Job.");
}

let failures = 0;

for (const test of cases) {
  try {
    const created = await submit(test);
    const job = await waitForJob(created.jobId);

    const errors = [];
    if (job.status !== test.expectStatus) errors.push(`status=${job.status}`);
    if (test.expectStdout && !job.stdout?.includes(test.expectStdout)) errors.push(`stdout inesperado=${JSON.stringify(job.stdout)}`);
    if (test.expectReason && job.failureReason !== test.expectReason) errors.push(`failureReason=${job.failureReason}`);

    if (errors.length) throw new Error(errors.join(", "));
    console.log(`PASS  ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${test.name}: ${error.message}`);
  }
}

try {
  const parallelJobs = await Promise.all(
    [1, 2, 3, 4].map((index) =>
      submit({
        language: "python",
        sourceCode: `import time\ntime.sleep(0.5)\nprint("job-${index}")`,
        stdin: "",
      })
    )
  );

  const results = await Promise.all(parallelJobs.map((item) => waitForJob(item.jobId)));
  results.forEach((job, index) => {
    const expected = `job-${index + 1}`;
    if (job.status !== "SUCCEEDED" || !job.stdout?.includes(expected)) {
      throw new Error(`Job concorrente ${index + 1} falhou: status=${job.status}`);
    }
  });
  console.log("PASS  Execução concorrente (4 Jobs em paralelo)");
} catch (error) {
  failures += 1;
  console.error(`FAIL  Execução concorrente: ${error.message}`);
}

if (failures > 0) {
  console.error(`\n${failures} teste(s) falharam.`);
  process.exit(1);
}

console.log("\nTodos os smoke tests passaram.");
