import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";

const MAX_TABS = 10;

function CodeEditor({
  languageKey,
  fileName,
  language,
  code,
  starterCode,
  onChange,
  onActiveTabChange,
}) {
  const nextTabNumber = useRef(2);
  const activeTabIdRef = useRef("tab-1");

  const [tabs, setTabs] = useState([
    {
      id: "tab-1",
      name: fileName,
      code,
      languageKey,
      monacoLanguage: language,
    },
  ]);

  const [activeTabId, setActiveTabId] = useState("tab-1");

  useEffect(() => {
    const currentActiveId = activeTabIdRef.current;

    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === currentActiveId && tab.code !== code ? { ...tab, code } : tab
      )
    );
  }, [code]);

  useEffect(() => {
    const currentActiveId = activeTabIdRef.current;

    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === currentActiveId
          ? {
              ...tab,
              name: fileName,
              languageKey,
              monacoLanguage: language,
            }
          : tab
      )
    );
  }, [fileName, languageKey, language]);

  function handleEditorWillMount(monaco) {
    monaco.editor.defineTheme("meuTema", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "", foreground: "334155" },
        { token: "keyword", foreground: "0F172A", fontStyle: "bold" },
        { token: "string", foreground: "64748B" },
        { token: "string.escape", foreground: "334155" },
        { token: "number", foreground: "0F172A" },
        { token: "type", foreground: "334155" },
        { token: "type.identifier", foreground: "334155" },
        { token: "identifier", foreground: "334155" },
        { token: "delimiter", foreground: "64748B" },
        { token: "operator", foreground: "0F172A" },
        { token: "comment", foreground: "94A3B8", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#FFFFFF",
        "editor.foreground": "#334155",
        "editorLineNumber.foreground": "#94A3B8",
        "editorLineNumber.activeForeground": "#0F172A",
        "editor.lineHighlightBackground": "#F1F5F9",
        "editor.lineHighlightBorder": "#00000000",
        "editorCursor.foreground": "#0F172A",
        "editor.selectionBackground": "#CBD5E180",
        "editor.inactiveSelectionBackground": "#E2E8F080",
        "editor.selectionHighlightBackground": "#E2E8F080",
        "editor.wordHighlightBackground": "#E2E8F080",
        "editor.wordHighlightStrongBackground": "#CBD5E180",
        "editorBracketMatch.background": "#F1F5F9",
        "editorBracketMatch.border": "#64748B",
        "editorWhitespace.foreground": "#CBD5E1",
        "editorIndentGuide.background1": "#E2E8F0",
        "editorIndentGuide.activeBackground1": "#94A3B8",
        "editorGutter.background": "#FFFFFF",
        "editorGutter.foldingControlForeground": "#94A3B8",
        "scrollbarSlider.background": "#CBD5E166",
        "scrollbarSlider.hoverBackground": "#94A3B899",
        "scrollbarSlider.activeBackground": "#64748B99",
        "editorSuggestWidget.background": "#FFFFFF",
        "editorSuggestWidget.border": "#CBD5E1",
        "editorSuggestWidget.foreground": "#334155",
        "editorSuggestWidget.selectedBackground": "#F1F5F9",
        "editorHoverWidget.background": "#FFFFFF",
        "editorHoverWidget.border": "#CBD5E1",
        "editorHoverWidget.foreground": "#334155",
      },
    });
  }

  function createNewFileName() {
    const tabNumber = nextTabNumber.current;
    const lastDotIndex = fileName.lastIndexOf(".");

    if (lastDotIndex === -1) return `${fileName}-${tabNumber}`;

    const name = fileName.substring(0, lastDotIndex);
    const extension = fileName.substring(lastDotIndex);
    return `${name}-${tabNumber}${extension}`;
  }

  function handleAddTab() {
    if (tabs.length >= MAX_TABS) return;

    const newTab = {
      id: `tab-${Date.now()}`,
      name: createNewFileName(),
      code: starterCode,
      languageKey,
      monacoLanguage: language,
    };

    nextTabNumber.current += 1;
    setTabs((currentTabs) => [...currentTabs, newTab]);
    activeTabIdRef.current = newTab.id;
    setActiveTabId(newTab.id);
    onChange(starterCode);
  }

  function handleSelectTab(tab) {
    if (tab.id === activeTabId) return;

    activeTabIdRef.current = tab.id;
    setActiveTabId(tab.id);
    onActiveTabChange(tab.languageKey, tab.code);
  }

  function handleCloseTab(tabId) {
    if (tabs.length === 1) return;

    const tabIndex = tabs.findIndex((tab) => tab.id === tabId);
    const remainingTabs = tabs.filter((tab) => tab.id !== tabId);
    setTabs(remainingTabs);

    if (tabId !== activeTabId) return;

    const nextActiveIndex = Math.min(tabIndex, remainingTabs.length - 1);
    const nextActiveTab = remainingTabs[nextActiveIndex];

    activeTabIdRef.current = nextActiveTab.id;
    setActiveTabId(nextActiveTab.id);
    onActiveTabChange(nextActiveTab.languageKey, nextActiveTab.code);
  }

  function handleEditorChange(value) {
    const newCode = value || "";

    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === activeTabId ? { ...tab, code: newCode } : tab
      )
    );

    onChange(newCode);
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  const limitReached = tabs.length >= MAX_TABS;

  return (
    <div className="code-area">
      <div className="editor-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`file-tab ${tab.id === activeTabId ? "active" : ""}`}
            onClick={() => handleSelectTab(tab)}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === activeTabId}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") handleSelectTab(tab);
            }}
          >
            <span className="file-icon">
              <div className="container-icon file">
                <img src="../../img/blank-page.png" alt="Icone de arquivo" />
              </div>
            </span>

            <span>{tab.name}</span>

            <button
              className="close-tab"
              type="button"
              disabled={tabs.length === 1}
              aria-label={`Fechar ${tab.name}`}
              title={
                tabs.length === 1
                  ? "Não é possível fechar a única tab"
                  : "Fechar tab"
              }
              onClick={(event) => {
                event.stopPropagation();
                handleCloseTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}

        <button
          className={`add-tab ${limitReached ? "disabled" : ""}`}
          type="button"
          aria-label="Adicionar nova tab"
          aria-disabled={limitReached}
          title={limitReached ? "Limite de 10 tabs atingido" : "Nova tab"}
          onClick={handleAddTab}
        >
          +
        </button>
      </div>

      <div className="monaco-wrapper">
        <Editor
          key={activeTab.id}
          height="100%"
          language={activeTab.monacoLanguage}
          value={activeTab.code}
          onChange={handleEditorChange}
          beforeMount={handleEditorWillMount}
          theme="meuTema"
          options={{
            fontSize: 15,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            lineNumbers: "on",
            glyphMargin: false,
            renderLineHighlight: "line",
            overviewRulerBorder: false,
            cursorBlinking: "smooth",
            padding: { top: 14 },
          }}
        />
      </div>
    </div>
  );
}

export default CodeEditor;
