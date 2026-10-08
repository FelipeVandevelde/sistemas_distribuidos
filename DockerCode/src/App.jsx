import { useEffect, useRef, useState } from "react";
import Header from "./components/Header";
import CodeEditor from "./components/CodeEditor";
import OutputPanel from "./components/OutputPanel";
import { delay, getJob, isTerminalStatus, submitJob } from "./services/api";

const languages = {
  python: {
    label: "Py",
    monaco: "python",
    file: "main.py",
    code: `print("Hello, World!")`,
  },
  javascript: {
    label: "Js",
    monaco: "javascript",
    file: "main.js",
    code: `console.log("Hello, World!");`,
  },
  java: {
    label: "Java",
    monaco: "java",
    file: "Main.java",
    code: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}`,
  },
  cpp: {
    label: "Cpp",
    monaco: "cpp",
    file: "main.cpp",
    code: `#include <iostream>
using namespace std;

int main() {
    cout << "Hello, World!" << endl;
    return 0;
}`,
  },
};

function formatJob(job) {
  if (!job) return "";

  if (!isTerminalStatus(job.status)) {
    return `Executando...\nStatus: ${job.status}`;
  }

  const sections = [`Status: ${job.status}`];

  if (job.stdout) {
    sections.push(`stdout:\n${job.stdout}`);
  }

  if (job.stderr) {
    sections.push(`stderr:\n${job.stderr}`);
  }

  if (job.exitCode !== null && job.exitCode !== undefined) {
    sections.push(`Exit code: ${job.exitCode}`);
  }

  if (job.failureReason) {
    sections.push(`Motivo: ${job.failureReason}`);
  }

  return sections.join("\n\n");
}

function App() {
  const workspaceRef = useRef(null);
  const runControllerRef = useRef(null);

  const [language, setLanguage] = useState("python");
  const [code, setCode] = useState(languages.python.code);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [activeTab, setActiveTab] = useState("console");
  const [editorWidth, setEditorWidth] = useState(61);
  const [resizing, setResizing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const currentLanguage = languages[language];

  function changeLanguage(newLanguage) {
    if (!languages[newLanguage]) return;

    setLanguage(newLanguage);
    setCode(languages[newLanguage].code);
    setOutput("");
  }

  function handleActiveTabChange(tabLanguage, tabCode) {
    if (!languages[tabLanguage]) return;

    setLanguage(tabLanguage);
    setCode(tabCode);
  }

  function clearOutput() {
    setOutput("");
    setActiveTab("console");
  }

  function resetCode() {
    setCode(currentLanguage.code);
  }

  async function runCode() {
    if (isRunning) return;

    if (!code.trim()) {
      setActiveTab("console");
      setOutput("Não é possível executar código vazio.");
      return;
    }

    runControllerRef.current?.abort();
    const controller = new AbortController();
    runControllerRef.current = controller;

    setIsRunning(true);
    setActiveTab("console");
    setOutput("Executando...\nStatus: SUBMITTING");

    try {
      const createdJob = await submitJob(
        {
          language,
          sourceCode: code,
          stdin: input,
        },
        controller.signal
      );

      let consecutiveErrors = 0;
      let currentJob = createdJob;
      setOutput(formatJob(currentJob));

      while (!isTerminalStatus(currentJob.status)) {
        await delay(750, controller.signal);

        try {
          currentJob = await getJob(createdJob.jobId, controller.signal);
          consecutiveErrors = 0;
          setOutput(formatJob(currentJob));
        } catch (error) {
          if (error?.name === "AbortError") throw error;

          consecutiveErrors += 1;
          if (consecutiveErrors >= 3) throw error;
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        setOutput(`Falha na execução.\n\n${error.message || "Erro inesperado."}`);
      }
    } finally {
      if (runControllerRef.current === controller) {
        runControllerRef.current = null;
        setIsRunning(false);
      }
    }
  }

  useEffect(() => {
    return () => {
      runControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    function handleMouseMove(event) {
      if (!resizing || !workspaceRef.current) return;

      const rect = workspaceRef.current.getBoundingClientRect();
      let percentage = ((event.clientX - rect.left) / rect.width) * 100;

      percentage = Math.max(30, Math.min(80, percentage));
      setEditorWidth(percentage);
    }

    function handleMouseUp() {
      setResizing(false);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizing]);

  return (
    <div className="app">
      <Header
        language={language}
        languages={languages}
        onLanguageChange={changeLanguage}
        onRun={runCode}
        onClearOutput={clearOutput}
        onResetCode={resetCode}
        isRunning={isRunning}
      />

      <main className="workspace" ref={workspaceRef}>
        <section className="editor-section" style={{ width: `${editorWidth}%` }}>
          <CodeEditor
            languageKey={language}
            fileName={currentLanguage.file}
            language={currentLanguage.monaco}
            code={code}
            starterCode={currentLanguage.code}
            onChange={setCode}
            onActiveTabChange={handleActiveTabChange}
          />
        </section>

        <div
          className={`resize-bar ${resizing ? "resizing" : ""}`}
          onMouseDown={() => setResizing(true)}
          title="Arraste para redimensionar"
        />

        <section className="output-section" style={{ width: `${100 - editorWidth}%` }}>
          <OutputPanel
            activeTab={activeTab}
            onTabChange={setActiveTab}
            output={output}
            input={input}
            onInputChange={setInput}
          />
        </section>
      </main>
    </div>
  );
}

export default App;
