function Header({
  language,
  languages,
  onLanguageChange,
  onRun,
  onClearOutput,
  onResetCode,
  isRunning,
}) {
  return (
    <header className="header">
      <div className="header-left">
        <div className="logo-icon">
          <img src="../../img/code.png" alt="DockerCode" />
        </div>

        <div className="logo-name">DockerCode</div>
      </div>

      <div className="header-center">
        <div className="language-select-wrapper">
          <select
            className="language-select"
            value={language}
            onChange={(event) => onLanguageChange(event.target.value)}
            aria-label="Selecionar linguagem"
            disabled={isRunning}
          >
            {Object.entries(languages).map(([key, item]) => (
              <option key={key} value={key}>
                {item.label}
              </option>
            ))}
          </select>

          <span className="arrow-icon" aria-hidden="true" />
        </div>

        <button
          className="run-button"
          onClick={onRun}
          type="button"
          disabled={isRunning}
          aria-busy={isRunning}
        >
          Run
          <span className="arrow-icon" aria-hidden="true" />
        </button>

        <div className="tooltip-wrapper">
          <button
            className="clear-output-button"
            aria-label="Limpar output"
            type="button"
            onClick={onClearOutput}
          >
            <div className="container-icon">
              <img src="../../img/delete.png" alt="Limpar output" />
            </div>
            <span className="tooltip">
              Limpar<br />Output
            </span>
          </button>
        </div>

        <div className="tooltip-wrapper">
          <button
            className="clear-output-button"
            aria-label="Resetar código"
            type="button"
            onClick={onResetCode}
          >
            <div className="container-icon">
              <img src="../../img/rotate.png" alt="Resetar código" />
            </div>
            <span className="tooltip">
              Resetar<br />Código
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}

export default Header;
