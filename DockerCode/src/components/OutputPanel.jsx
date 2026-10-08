function OutputPanel({
  activeTab,
  onTabChange,
  output,
  input,
  onInputChange,
}) {
  return (
    <div className="output-panel">
      <div className="output-tabs">
        <button
          className={activeTab === "console" ? "output-tab active" : "output-tab"}
          onClick={() => onTabChange("console")}
        >
          Console
        </button>

        <button
          className={activeTab === "io" ? "output-tab active" : "output-tab"}
          onClick={() => onTabChange("io")}
        >
          I/O
        </button>
      </div>

      <div className="output-content">
        {activeTab === "console" && (
          <>
            {!output ? (
              <div className="empty-console">
                <div className="console-title">Live Console</div>
                <div className="console-description">Click Run to start</div>
              </div>
            ) : (
              <pre className="console-output">{output}</pre>
            )}
          </>
        )}

        {activeTab === "io" && (
          <div className="io-container">
            <textarea
              className="io-textarea"
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              placeholder="Digite aqui os dados que serão enviados para o programa..."
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default OutputPanel;
