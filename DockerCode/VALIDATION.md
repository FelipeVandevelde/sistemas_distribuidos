# Validação desta entrega

## VALIDADO

- Sintaxe dos arquivos React/JS/JSX verificada com parser Babel.
- `scripts/smoke-test.mjs` verificado com `node --check`.
- `package.json` e `package-lock.json` parseados como JSON válido.
- `docker-compose.yml` parseado como YAML válido, incluindo anchors/merge das duas réplicas.
- Os três `.csproj` parseados como XML válido.
- Delimitadores estruturais dos arquivos C# verificados com lexer C# (Pygments), sem chaves/parênteses/colchetes desbalanceados fora de strings/comentários.
- Cópia de assets `img/ -> dist/img/` executada com sucesso; os cinco arquivos visuais originais foram preservados.
- Estrutura final verificada sem `node_modules/`, `dist/`, `bin/` ou `obj/`.

## NÃO VALIDADO NESTE AMBIENTE

### `npm install` / `npm run build`

**MOTIVO:** o ambiente de execução não possui acesso DNS ao npm (`EAI_AGAIN registry.npmjs.org`) e não possui cache suficiente para `npm ci --offline`. Por isso não foi possível reinstalar as dependências Linux e concluir o build Vite neste ambiente.

### `dotnet restore` / `dotnet build`

**MOTIVO:** o .NET SDK não está instalado no ambiente disponibilizado.

### `docker compose config` / `docker compose build` / `docker compose up`

**MOTIVO:** Docker/Compose não estão instalados no ambiente disponibilizado.

### Smoke tests reais das quatro linguagens

**MOTIVO:** dependem do Docker Engine e do ambiente completo em execução. Foi incluído `scripts/smoke-test.mjs` para executar esses testes após `docker compose up`.
