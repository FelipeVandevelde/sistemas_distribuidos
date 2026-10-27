import type {
  BehaviorProfileId,
  BehaviorProfileLabel,
  FailureReason,
  JobStatus,
  LanguageId,
  LanguageLabel,
} from '../../src/shared/protocol.ts'

export interface ExecutionPresetResult {
  language: LanguageId
  languageLabel: LanguageLabel
  profile: BehaviorProfileId
  profileLabel: BehaviorProfileLabel
  image: string
  sourceFileName: string
  command: string
  sourceCode: string
  defaultStdin: string
  finalStatus: JobStatus
  exitCode: number | null
  failureReason: FailureReason
  oomKilled: boolean
  timedOut: boolean
  execTimeMs: number
  buildStdout: (stdin: string) => string
  stderr: string
}

export const LANGUAGE_MAP: Record<LanguageLabel, LanguageId> = {
  'Python 3.12': 'python',
  'Node.js 22': 'javascript',
  'Java 21': 'java',
  'C++ 14': 'cpp',
}

export const PROFILE_MAP: Record<BehaviorProfileLabel, BehaviorProfileId> = {
  'Execução Limpa (Sucesso)': 'SUCCESS',
  'Erro de Compilação (javac/g++)': 'COMPILE_ERROR',
  'Erro de Runtime': 'RUNTIME_ERROR',
  'Estouro de Memória (OOM 256MB)': 'MEMORY_LIMIT',
  'Loop Infinito (Timeout 10s)': 'TIMEOUT',
}

const SPECS: Record<
  LanguageId,
  { image: string; file: string; cmd: string; shortLabel: string }
> = {
  python: {
    image: 'dockercode-sandbox-python:latest',
    file: 'main.py',
    cmd: 'python /workspace/main.py < /workspace/stdin.txt',
    shortLabel: 'Python',
  },
  javascript: {
    image: 'dockercode-sandbox-javascript:latest',
    file: 'main.js',
    cmd: 'node /workspace/main.js < /workspace/stdin.txt',
    shortLabel: 'Node',
  },
  java: {
    image: 'dockercode-sandbox-java:latest',
    file: 'Main.java',
    cmd: "cd /workspace; javac Main.java || { code=$?; echo '__DOCKERCODE_COMPILE_ERROR__' >&2; exit $code; }; java Main < stdin.txt",
    shortLabel: 'Java',
  },
  cpp: {
    image: 'dockercode-sandbox-cpp:latest',
    file: 'main.cpp',
    cmd: "cd /workspace; g++ main.cpp -O2 -o main || { code=$?; echo '__DOCKERCODE_COMPILE_ERROR__' >&2; exit $code; }; ./main < stdin.txt",
    shortLabel: 'C++',
  },
}

export function getExecutionPreset(
  languageLabel: LanguageLabel,
  profileLabel: BehaviorProfileLabel,
): ExecutionPresetResult {
  const language = LANGUAGE_MAP[languageLabel] ?? 'python'
  const profile = PROFILE_MAP[profileLabel] ?? 'SUCCESS'
  const spec = SPECS[language]

  if (profile === 'SUCCESS') {
    const codes: Record<LanguageId, string> = {
      python: `name = input()\nprint(f"Olá, {name}!")`,
      javascript: `const fs = require("fs");\nconst name = fs.readFileSync(0, "utf8").trim();\nconsole.log(\`Olá, \${name}!\`);`,
      java: `import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner s = new Scanner(System.in);\n    String name = s.hasNextLine() ? s.nextLine() : "Mundo";\n    System.out.println("Olá, " + name + "!");\n  }\n}`,
      cpp: `#include <iostream>\n#include <string>\nint main() {\n  std::string name;\n  std::getline(std::cin, name);\n  std::cout << "Olá, " << name << "!" << std::endl;\n  return 0;\n}`,
    }
    const execTimes: Record<LanguageId, number> = {
      python: 84,
      javascript: 96,
      java: 640,
      cpp: 480,
    }
    return {
      language,
      languageLabel,
      profile,
      profileLabel,
      image: spec.image,
      sourceFileName: spec.file,
      command: spec.cmd,
      sourceCode: codes[language],
      defaultStdin: 'DockerTracer',
      finalStatus: 'SUCCEEDED',
      exitCode: 0,
      failureReason: null,
      oomKilled: false,
      timedOut: false,
      execTimeMs: execTimes[language],
      buildStdout: (stdin: string) => `Olá, ${(stdin || 'DockerTracer').trim()}!\n`,
      stderr: '',
    }
  }

  if (profile === 'COMPILE_ERROR') {
    const codes: Record<LanguageId, string> = {
      python: `def broken_syntax(\n    print("faltou fechar parêntese")`,
      javascript: `function broken( {\n  console.log("erro de sintaxe");\n}`,
      java: `public class Main {\n  public static void main(String[] args) {\n    System.out.println("faltou ponto e virgula")\n  }\n}`,
      cpp: `#include <iostream>\nint main() {\n  std::cout << "faltou ponto e virgula" << std::endl\n  return 0;\n}`,
    }
    const stderrs: Record<LanguageId, string> = {
      python: `  File "/workspace/main.py", line 1\n    def broken_syntax(\n                     ^\nSyntaxError: '(' was never closed`,
      javascript: `/workspace/main.js:1\nfunction broken( {\n                 ^\nSyntaxError: Unexpected token '{'`,
      java: `Main.java:3: error: ';' expected\n    System.out.println("faltou ponto e virgula")\n                                                ^\n1 error`,
      cpp: `main.cpp: In function 'int main()':\nmain.cpp:3:53: error: expected ';' before 'return'\n    3 |   std::cout << "faltou ponto e virgula" << std::endl\n      |                                                     ^\n      |                                                     ;`,
    }
    // No DockerCode real, javac e g++ emitem __DOCKERCODE_COMPILE_ERROR__ -> COMPILE_ERROR,
    // enquanto Python/Node falham no interpretador -> RUNTIME_ERROR (ou COMPILE_ERROR didático)
    const isCompiledLang = language === 'java' || language === 'cpp'
    return {
      language,
      languageLabel,
      profile,
      profileLabel,
      image: spec.image,
      sourceFileName: spec.file,
      command: spec.cmd,
      sourceCode: codes[language],
      defaultStdin: '',
      finalStatus: 'FAILED',
      exitCode: 1,
      failureReason: isCompiledLang ? 'COMPILE_ERROR' : 'COMPILE_ERROR',
      oomKilled: false,
      timedOut: false,
      execTimeMs: isCompiledLang ? 390 : 72,
      buildStdout: () => '',
      stderr: stderrs[language],
    }
  }

  if (profile === 'RUNTIME_ERROR') {
    const codes: Record<LanguageId, string> = {
      python: `raise RuntimeError("Falha crítica durante execução no sandbox")`,
      javascript: `throw new Error("Falha crítica durante execução no sandbox");`,
      java: `public class Main {\n  public static void main(String[] args) {\n    throw new RuntimeException("Falha crítica no sandbox");\n  }\n}`,
      cpp: `#include <stdexcept>\nint main() {\n  throw std::runtime_error("Falha crítica no sandbox");\n}`,
    }
    const stderrs: Record<LanguageId, string> = {
      python: `Traceback (most recent call last):\n  File "/workspace/main.py", line 1, in <module>\n    raise RuntimeError("Falha crítica durante execução no sandbox")\nRuntimeError: Falha crítica durante execução no sandbox`,
      javascript: `/workspace/main.js:1\nthrow new Error("Falha crítica durante execução no sandbox");\n^\nError: Falha crítica durante execução no sandbox`,
      java: `Exception in thread "main" java.lang.RuntimeException: Falha crítica no sandbox\n\tat Main.main(Main.java:3)`,
      cpp: `terminate called after throwing an instance of 'std::runtime_error'\n  what():  Falha crítica no sandbox\nAborted`,
    }
    return {
      language,
      languageLabel,
      profile,
      profileLabel,
      image: spec.image,
      sourceFileName: spec.file,
      command: spec.cmd,
      sourceCode: codes[language],
      defaultStdin: '',
      finalStatus: 'FAILED',
      exitCode: language === 'cpp' ? 134 : 1,
      failureReason: 'RUNTIME_ERROR',
      oomKilled: false,
      timedOut: false,
      execTimeMs: 115,
      buildStdout: () => '',
      stderr: stderrs[language],
    }
  }

  if (profile === 'MEMORY_LIMIT') {
    const codes: Record<LanguageId, string> = {
      python: `data = []\nwhile True:\n    data.append(bytearray(8 * 1024 * 1024)) # Aloca blocos de 8 MiB > 256 MiB`,
      javascript: `const chunks = [];\nwhile (true) {\n  chunks.push(Buffer.alloc(8 * 1024 * 1024, 1));\n}`,
      java: `import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    List<byte[]> list = new ArrayList<>();\n    while (true) list.add(new byte[8 * 1024 * 1024]);\n  }\n}`,
      cpp: `#include <vector>\n#include <cstring>\nint main() {\n  std::vector<char*> v;\n  while (true) {\n    char* p = new char[8 * 1024 * 1024];\n    std::memset(p, 1, 8 * 1024 * 1024);\n    v.push_back(p);\n  }\n}`,
    }
    return {
      language,
      languageLabel,
      profile,
      profileLabel,
      image: spec.image,
      sourceFileName: spec.file,
      command: spec.cmd,
      sourceCode: codes[language],
      defaultStdin: '',
      finalStatus: 'FAILED',
      exitCode: 137,
      failureReason: 'MEMORY_LIMIT',
      oomKilled: true,
      timedOut: false,
      execTimeMs: 295,
      buildStdout: () => '',
      stderr: 'Killed (cgroup memory.max = 268435456 bytes exceeded / OOMKilled=true)',
    }
  }

  // TIMEOUT (Loop Infinito 10s)
  const timeoutCodes: Record<LanguageId, string> = {
    python: `while True:\n    pass  # Excede Sandbox:TimeoutSeconds = 10s`,
    javascript: `while (true) {\n  // Excede Sandbox:TimeoutSeconds = 10s\n}`,
    java: `public class Main {\n  public static void main(String[] args) {\n    while (true) {}\n  }\n}`,
    cpp: `int main() {\n  while (true) {}\n  return 0;\n}`,
  }

  return {
    language,
    languageLabel,
    profile: 'TIMEOUT',
    profileLabel: 'Loop Infinito (Timeout 10s)',
    image: spec.image,
    sourceFileName: spec.file,
    command: spec.cmd,
    sourceCode: timeoutCodes[language],
    defaultStdin: '',
    finalStatus: 'TIMEOUT',
    exitCode: null,
    failureReason: 'TIMEOUT',
    oomKilled: false,
    timedOut: true,
    execTimeMs: 10000,
    buildStdout: () => '',
    stderr: '[Sandbox Timeout] Execução interrompida após 10.0s via POST /containers/{id}/kill (SIGKILL).',
  }
}
