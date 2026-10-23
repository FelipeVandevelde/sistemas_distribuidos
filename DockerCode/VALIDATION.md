# Validação desta entrega

Ambiente: Windows + Docker Desktop (Linux containers), .NET SDK 8/9, Node.js 24.

## VALIDADO

- `dotnet build` de `SubmissionApi`, `ResultService` e `ExecutionWorker`: 0 erros, 0 avisos.
- `npm ci` e `npm run build` (Vite + cópia de `img/` para `dist/img/`): sucesso.
- `docker compose build` / `docker compose up`: todos os serviços sobem; `sandbox-builder` encerra com código 0.
- `node scripts/smoke-test.mjs` com o sistema em execução:
  - Python com stdin, JavaScript, Java, C++
  - erro de compilação Java e C++
  - runtime error Python
  - limite de memória Python (`MEMORY_LIMIT`)
  - truncamento de saída Python (> 64 KiB)
  - timeout Python (`TIMEOUT`)
  - execução concorrente de 4 Jobs em paralelo entre os Workers
- Fluxo HTTP completo via Nginx (`http://localhost:8080`): `POST /api/jobs` + `GET /api/jobs/{id}` retornando `SUCCEEDED` com stdout correto.
- Limpeza: após os testes não restaram containers de sandbox nem volumes `dockercode-*` órfãos.
- Rebuild completo do sistema e testes manuais pelo usuário no front-end: funcionando corretamente.

## CORREÇÕES FEITAS NA VALIDAÇÃO

1. **`PutArchive` retornava `400 container rootfs is marked read-only`** (todos os Jobs terminavam em `INFRA_ERROR`).
   O Docker não aceita `PUT /containers/{id}/archive` em container com rootfs read-only, mesmo com o destino em `HostConfig.Tmpfs`.
   Solução: o `/workspace` agora é um volume `local` com driver tmpfs, criado por Job e removido ao final. Continua em memória, com rootfs read-only e `exec` habilitado.
2. **Binário C++ sem permissão de execução**: tmpfs do Docker é `noexec` por padrão; o volume do `/workspace` agora usa `exec`.
3. **`sh -lc` → `sh -c`**: o shell de login do Alpine redefine o `PATH` e esconderia o `java` da imagem `eclipse-temurin`.

## NÃO VALIDADO

- Testes de carga de alto volume (stress test prolongado).
- Roteiros formais de falha (derrubar RabbitMQ/PostgreSQL/Worker durante a execução e verificar redelivery/lease).
- Docker Engine nativo em Linux (a validação foi feita com Docker Desktop no Windows).
