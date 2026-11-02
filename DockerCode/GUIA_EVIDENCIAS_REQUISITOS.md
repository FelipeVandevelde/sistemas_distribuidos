# DockerCode — Evidências dos Requisitos
**Como localizar:** os caminhos abaixo partem da raiz `sistemas_distribuidos-main/`. No VS Code, abra essa pasta e use **Ctrl+P**, digitando o caminho e `:linha` (exemplo: `DockerCode/src/App.jsx:111`).

## Parte 1 — Requisitos Funcionais (RF01 a RF06)

### RF01 — Edição e Submissão Multi-linguagem

**Descrição do requisito**

O sistema deve fornecer um editor de código (`CodeEditor.jsx`) que permita ao utilizador escrever e submeter scripts nas linguagens suportadas pelas imagens de sandbox: C++, Java, JavaScript e Python (`sandbox-images/`).

**Por que esse requisito é importante?**

Centraliza a escrita e a submissão de programas em quatro linguagens na mesma interface.

**Evidências no projeto**

**1. Editor interativo**

- **Arquivo:** `DockerCode/src/components/CodeEditor.jsx`
- **Linhas:** `232–253`
- **Método/componente:** CodeEditor / Monaco Editor.
- **O que faz:** Exibe o editor, recebe o código e encaminha as alterações pelo evento `onChange`.
- **Relação com o requisito:** Comprova a edição de código-fonte.

**2. Linguagens disponíveis**

- **Arquivo:** `DockerCode/src/App.jsx`
- **Linhas:** `7–42`
- **Método/componente:** languages.
- **O que faz:** Define Python, JavaScript, Java e C++, com arquivos e códigos iniciais próprios.
- **Relação com o requisito:** Comprova as quatro opções oferecidas ao usuário.

**3. Envio da execução**

- **Arquivos e linhas:** `DockerCode/src/App.jsx` (`111–136`); `DockerCode/src/services/api.js` (`16–38`).
- **Método/componente:** runCode() / submitJob().
- **O que faz:** Obtém linguagem, código e entrada; `submitJob()` envia uma requisição HTTP `POST /api/jobs`.
- **Relação com o requisito:** Liga o editor à submissão de programas.

**4. Correspondência com as sandboxes**

- **Arquivo:** `DockerCode/services/ExecutionWorker/DockerEngineClient.cs`
- **Linhas:** `15–34`
- **Método/componente:** Specs.
- **O que faz:** Relaciona cada linguagem à respectiva imagem Docker e ao comando de execução.
- **Relação com o requisito:** Confirma que as opções da interface possuem configuração de sandbox.

**Resumo do requisito**

> O usuário escolhe uma das quatro linguagens e escreve o programa no Monaco Editor. Ao executar, o frontend envia o código à API; o Worker possui uma imagem de sandbox configurada para cada linguagem.

---

### RF02 — Enfileiramento Assíncrono de Trabalhos

**Descrição do requisito**

A `SubmissionApi` deve receber o código submetido, atribuir um identificador único ao trabalho (*Job ID*) e enviá-lo para a fila de execução sem aguardar o término do processamento.

**Por que esse requisito é importante?**

Evita que o cliente permaneça aguardando a compilação ou execução do programa.

**Evidências no projeto**

**1. Recepção da submissão**

- **Arquivo:** `DockerCode/services/SubmissionApi/Program.cs`
- **Linhas:** `40–52`
- **Método/componente:** MapPost("/api/jobs") / Validate().
- **O que faz:** Recebe o payload e rejeita dados inválidos antes do enfileiramento.
- **Relação com o requisito:** Comprova a entrada do trabalho pela API.

**2. Identificador e registro inicial**

- **Arquivo:** `DockerCode/services/ResultService/Program.cs`
- **Linhas:** `186–207`
- **Método/componente:** JobRepository.CreateAsync().
- **O que faz:** Gera um `Guid`, grava o trabalho no PostgreSQL com estado `QUEUED` e retorna o ID.
- **Relação com o requisito:** Comprova a atribuição do identificador único ao Job.

**3. Publicação sem esperar execução**

- **Arquivos e linhas:** `DockerCode/services/SubmissionApi/Program.cs` (`63–92`); `DockerCode/services/SubmissionApi/Program.cs` (`288–315`).
- **Método/componente:** RabbitPublisher.Publish() / MapPost.
- **O que faz:** A API registra o Job, publica uma mensagem persistente no RabbitMQ e responde com HTTP `202 Accepted`.
- **Relação com o requisito:** Comprova que o retorno não depende da conclusão da execução.

**4. Consumo posterior**

- **Arquivo:** `DockerCode/services/ExecutionWorker/JobConsumer.cs`
- **Linhas:** `69–82`
- **Método/componente:** JobConsumer.ExecuteAsync().
- **O que faz:** Configura um consumidor independente para a mesma fila `execution.jobs`.
- **Relação com o requisito:** Mostra o desacoplamento entre submissão e execução.

**Resumo do requisito**

> A API recebe o código e registra um Job com ID único. Ela publica a mensagem no RabbitMQ e devolve `202 Accepted`, enquanto o Worker busca e executa o trabalho separadamente. A API espera o registro e a confirmação da fila, mas não a execução do código.

---

### RF03 — Provisionamento Dinâmico de Sandboxes

**Descrição do requisito**

O `ExecutionWorker` deve consumir o trabalho da fila, converter o código num pacote TAR (`TarArchiveHelper.cs`) e injetá-lo num contentor Docker recém-criado a partir da imagem correspondente à linguagem (`DockerEngineClient.cs`).

**Por que esse requisito é importante?**

Cria um ambiente de execução separado para cada trabalho e linguagem.

**Evidências no projeto**

**1. Recebimento e início da execução**

- **Arquivos e linhas:** `DockerCode/services/ExecutionWorker/JobConsumer.cs` (`69–82`); `DockerCode/services/ExecutionWorker/JobConsumer.cs` (`172–185`).
- **Método/componente:** JobConsumer.ExecuteAsync() / HandleMessageAsync().
- **O que faz:** Consome mensagens do RabbitMQ e encaminha o trabalho obtido para `DockerEngineClient.ExecuteAsync()`.
- **Relação com o requisito:** Conecta a fila ao provisionamento da sandbox.

**2. Imagem correspondente à linguagem**

- **Arquivo:** `DockerCode/services/ExecutionWorker/DockerEngineClient.cs`
- **Linhas:** `15–34`
- **Método/componente:** Specs.
- **O que faz:** Associa as quatro linguagens a imagens Docker, arquivos-fonte e comandos próprios.
- **Relação com o requisito:** Comprova a seleção da imagem adequada.

**3. Montagem do pacote TAR**

- **Arquivo:** `DockerCode/services/ExecutionWorker/TarArchiveHelper.cs`
- **Linhas:** `7–49`
- **Método/componente:** TarArchiveHelper.Create() / WriteFile().
- **O que faz:** Escreve os cabeçalhos e conteúdos dos arquivos em um pacote TAR mantido em memória.
- **Relação com o requisito:** Comprova a conversão do código em TAR.

**4. Criação e envio dos arquivos**

- **Arquivos e linhas:** `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` (`96–120`); `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` (`223–289`).
- **Método/componente:** ExecuteAsync() / CreateContainerAsync() / PutArchiveAsync().
- **O que faz:** Cria e inicia o contêiner Docker e envia para `/workspace` o TAR com código, entrada e marcador de prontidão.
- **Relação com o requisito:** Comprova o provisionamento e a injeção dos arquivos.

**Resumo do requisito**

> O Worker consome o Job e seleciona a imagem da linguagem. O código e a entrada são empacotados em TAR, e o Docker Engine recebe comandos para criar o contêiner e copiar o pacote para seu espaço de trabalho.

---

### RF04 — Captura de Saída e Limpeza

**Descrição do requisito**

O trabalhador deve capturar os fluxos de saída padrão (stdout), erros de compilação/execução (stderr) e o estado de término do contentor, realizando a tentativa de remoção do contentor após a execução e registrando eventuais falhas.

**Por que esse requisito é importante?**

Permite apresentar os resultados e reduz a permanência de recursos temporários após cada Job.

**Evidências no projeto**

**1. Espera e coleta do resultado**

- **Arquivos e linhas:** `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` (`122–159`); `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` (`309–325`).
- **Método/componente:** ExecuteAsync() / WaitContainerAsync() / GetLogsAsync() / InspectContainerAsync().
- **O que faz:** Aguarda o término, coleta os logs e consulta o estado do contêiner para obter saída, código de término e informação de falta de memória.
- **Relação com o requisito:** Comprova a captura dos dados da execução.

**2. Separação de stdout e stderr**

- **Arquivo:** `DockerCode/services/ExecutionWorker/DockerEngineClient.cs`
- **Linhas:** `341–367`
- **Método/componente:** ParseMultiplexedLogs().
- **O que faz:** Lê os quadros dos logs da API Docker e separa o fluxo de saída comum do fluxo de erros.
- **Relação com o requisito:** Comprova a distinção entre `stdout` e `stderr`.

**3. Limpeza e registro de falhas**

- **Arquivos e linhas:** `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` (`161–185`); `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` (`328–332`).
- **Método/componente:** finally / DeleteContainerAsync().
- **O que faz:** No bloco `finally`, tenta excluir o contêiner e o volume; se a remoção falhar, registra um aviso.
- **Relação com o requisito:** Comprova a **tentativa** de limpeza, sem garantir remoção em toda falha.

**Resumo do requisito**

> Depois da execução, o Worker coleta os logs e o código de término do contêiner. O método separa stdout e stderr e, ao final, tenta remover o contêiner e o volume temporário. Se ocorrer falha na limpeza, registra um aviso.

---

### RF05 — Persistência e Consulta de Resultados

**Descrição do requisito**

O `ExecutionWorker` deve reportar o resultado final ao `ResultService` (`ResultServiceClient.cs`), e o painel da interface (`OutputPanel.jsx`) deve apresentar o resultado obtido por consultas periódicas da aplicação (`src/App.jsx`) quando for identificada a conclusão do processamento.

**Por que esse requisito é importante?**

Permite recuperar resultados já processados e apresentá-los na interface mesmo após a resposta inicial da submissão.

**Evidências no projeto**

**1. Envio do resultado final**

- **Arquivos e linhas:** `DockerCode/services/ExecutionWorker/JobConsumer.cs` (`197–212`); `DockerCode/services/ExecutionWorker/ResultServiceClient.cs` (`32–42`).
- **Método/componente:** HandleMessageAsync() / ResultServiceClient.CompleteAsync().
- **O que faz:** O Worker envia status, stdout, stderr e código de saída ao endpoint interno de conclusão.
- **Relação com o requisito:** Comprova a comunicação do Worker com o ResultService.

**2. Persistência no banco**

- **Arquivo:** `DockerCode/services/ResultService/Program.cs`
- **Linhas:** `315–345`
- **Método/componente:** JobRepository.CompleteAsync().
- **O que faz:** Atualiza no PostgreSQL o estado final, as saídas, o código de término e a data de conclusão.
- **Relação com o requisito:** Comprova o armazenamento durável do resultado.

**3. Consultas periódicas**

- **Arquivos e linhas:** `DockerCode/src/App.jsx` (`138–155`); `DockerCode/src/services/api.js` (`40–61`).
- **Método/componente:** runCode() / getJob().
- **O que faz:** A interface consulta `GET /api/jobs/{id}` a cada 750 ms até receber um estado terminal.
- **Relação com o requisito:** Comprova que a atualização ocorre por polling, e não por push imediato.

**4. Exibição no painel**

- **Arquivo:** `DockerCode/src/components/OutputPanel.jsx`
- **Linhas:** `26–36`
- **Método/componente:** OutputPanel.
- **O que faz:** Apresenta na área Console o texto de resultado fornecido pelo componente principal.
- **Relação com o requisito:** Comprova a visualização do resultado consultado.

**Resumo do requisito**

> Ao terminar o trabalho, o Worker envia o resultado ao ResultService, que o grava no PostgreSQL. O componente App consulta periodicamente o Job e passa o resultado ao OutputPanel. A atualização acontece na próxima consulta, não instantaneamente.

---

### RF06 — Monitorização de Saúde (Health Checks)

**Descrição do requisito**

Os serviços e trabalhadores devem expor o seu estado operacional (`WorkerHealthState.cs`) por meio de endpoints de verificação de saúde, permitindo a consulta do estado dos componentes no ambiente de contentores.

**Por que esse requisito é importante?**

Facilita verificar se os serviços estão operacionais e se suas dependências básicas estão acessíveis.

**Evidências no projeto**

**1. Saúde da SubmissionApi**

- **Arquivo:** `DockerCode/services/SubmissionApi/Program.cs`
- **Linhas:** `154–162`
- **Método/componente:** MapGet("/health").
- **O que faz:** Retorna estado saudável quando o ResultService e o RabbitMQ estão acessíveis.
- **Relação com o requisito:** Comprova o endpoint de saúde da API.

**2. Saúde do ResultService**

- **Arquivos e linhas:** `DockerCode/services/ResultService/Program.cs` (`71–82`); `DockerCode/services/ResultService/Program.cs` (`364–371`).
- **Método/componente:** MapGet("/health") / CheckHealthAsync().
- **O que faz:** Executa `SELECT 1` no PostgreSQL e retorna `Healthy` ou `Unhealthy`.
- **Relação com o requisito:** Comprova a verificação de saúde do serviço de resultados.

**3. Saúde do ExecutionWorker**

- **Arquivo:** `DockerCode/services/ExecutionWorker/Program.cs`
- **Linhas:** `17–29`
- **Método/componente:** MapGet("/health").
- **O que faz:** Responde conforme os indicadores de prontidão do Docker e do RabbitMQ.
- **Relação com o requisito:** Comprova o endpoint do trabalhador.

**4. Indicadores do Worker**

- **Arquivos e linhas:** `DockerCode/services/ExecutionWorker/WorkerHealthState.cs` (`1–12`); `DockerCode/services/ExecutionWorker/JobConsumer.cs` (`28–47`); `DockerCode/services/ExecutionWorker/JobConsumer.cs` (`69–103`).
- **Método/componente:** WorkerHealthState / JobConsumer.ExecuteAsync().
- **O que faz:** Mantém e atualiza os indicadores `DockerReady` e `RabbitReady` durante a inicialização e conexão.
- **Relação com o requisito:** Mostra a origem dos estados informados pelo endpoint; não comprova monitoração contínua do Docker.

**Resumo do requisito**

> Cada serviço .NET possui um endpoint `/health`. A API verifica suas dependências, o ResultService consulta o banco e o Worker informa os estados registrados para Docker e RabbitMQ. Isso permite consultar a saúde, sem pressupor controle automático do Docker Compose.

---

## Parte 2 — Requisitos Não Funcionais (RNF01 a RNF05)

### RNF01 — Isolamento e Segurança (Sandboxing)

**Descrição do requisito**

Todo o código submetido por utilizadores deve correr dentro de contentores Docker configurados com restrições de isolamento (`sandbox-images/`), sem acesso à rede interna dos microsserviços nem montagem direta de diretórios do hospedeiro, além de limites configurados de CPU, memória e tempo máximo de execução (`timeout`).

**Por que esse requisito é importante?**

Restringe o ambiente que executa código não confiável e limita o consumo de recursos da sandbox.

**Evidências no projeto**

**1. Restrições de isolamento**

- **Arquivo:** `DockerCode/services/ExecutionWorker/DockerEngineClient.cs`
- **Linhas:** `233–265`
- **Método/componente:** CreateContainerAsync().
- **O que faz:** Define rede `none`, raiz somente leitura, usuário `10001`, remoção de capacidades e limites de memória, CPU e processos.
- **Relação com o requisito:** Comprova os mecanismos configurados de isolamento e recursos.

**2. Valores aplicados pela infraestrutura**

- **Arquivo:** `DockerCode/docker-compose.yml`
- **Linhas:** `107–113`
- **Método/componente:** worker-environment.
- **O que faz:** Configura timeout de 10 s, 256 MiB, 1 CPU e 64 PIDs para os Workers usarem na criação das sandboxes.
- **Relação com o requisito:** Comprova os valores previstos no ambiente distribuído.

**3. Tempo máximo de execução**

- **Arquivo:** `DockerCode/services/ExecutionWorker/DockerEngineClient.cs`
- **Linhas:** `122–135`
- **Método/componente:** ExecuteAsync() / WaitContainerAsync() / KillContainerAsync().
- **O que faz:** Aplica o prazo ao aguardar a execução e solicita encerramento do contêiner quando o prazo é excedido.
- **Relação com o requisito:** Comprova o mecanismo de timeout.

**4. Área de trabalho sem diretório do host**

- **Arquivos e linhas:** `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` (`197–214`); `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` (`241–255`).
- **Método/componente:** CreateWorkspaceVolumeAsync() / CreateContainerAsync().
- **O que faz:** Cria volume Docker com `tmpfs` para `/workspace`; não adiciona bind mount de caminho direto do hospedeiro à sandbox.
- **Relação com o requisito:** Comprova a configuração do espaço temporário, sem atestar resistência a ataques.

**Resumo do requisito**

> A sandbox é criada sem rede, com usuário sem privilégios, sistema de arquivos raiz somente leitura e limites de CPU, memória, processos e tempo. O espaço de trabalho usa um volume temporário em memória, sem montar diretamente pastas do host. São restrições configuradas; sua eficácia contra ataques precisa de testes específicos.

---

### RNF02 — Desacoplamento Temporal e Espacial

**Descrição do requisito**

A `SubmissionApi` e o `ExecutionWorker` não comunicam de forma síncrona direta; se os trabalhadores estiverem sobrecarregados ou temporariamente indisponíveis, a API continua a aceitar submissões normalmente.

**Por que esse requisito é importante?**

Mantém a recepção de novos Jobs separada da capacidade imediata de processamento dos Workers.

**Evidências no projeto**

**1. Submissão sem esperar o Worker**

- **Arquivo:** `DockerCode/services/SubmissionApi/Program.cs`
- **Linhas:** `63–92`
- **Método/componente:** MapPost("/api/jobs").
- **O que faz:** Registra o trabalho, publica na fila e responde ao cliente antes do término de sua execução.
- **Relação com o requisito:** Comprova o desacoplamento temporal da API.

**2. Fila persistente**

- **Arquivo:** `DockerCode/services/SubmissionApi/Program.cs`
- **Linhas:** `288–315`
- **Método/componente:** RabbitPublisher.Publish() / EnsureChannel().
- **O que faz:** Declara uma fila durável e publica mensagens persistentes com confirmação do broker.
- **Relação com o requisito:** Comprova o intermediário que separa produtores e consumidores.

**3. Consumo independente**

- **Arquivo:** `DockerCode/services/ExecutionWorker/JobConsumer.cs`
- **Linhas:** `50–85`
- **Método/componente:** JobConsumer.ExecuteAsync().
- **O que faz:** O Worker mantém conexão própria com RabbitMQ e consome mensagens posteriormente.
- **Relação com o requisito:** Comprova que não há chamada síncrona direta da API ao Worker.

**Resumo do requisito**

> A SubmissionApi envia Jobs para o RabbitMQ e não faz chamadas diretas aos Workers. Assim, eles podem consumir os trabalhos em outro momento. A aceitação de novas submissões depende de RabbitMQ e ResultService disponíveis, mesmo quando os Workers estiverem temporariamente indisponíveis.

---

### RNF03 — Escalabilidade Horizontal

**Descrição do requisito**

A arquitetura deve permitir escalar o número de instâncias do `ExecutionWorker` de forma independente da `SubmissionApi` e do `ResultService` para distribuir trabalhos concorrentes (com cenários de carga definidos no script `scripts/load-test.mjs`).

**Por que esse requisito é importante?**

Permite dividir trabalhos concorrentes entre vários consumidores em vez de concentrá-los em um único Worker.

**Evidências no projeto**

**1. Duas instâncias configuradas**

- **Arquivo:** `DockerCode/docker-compose.yml`
- **Linhas:** `94–139`
- **Método/componente:** worker-1 / worker-2.
- **O que faz:** Define dois serviços ExecutionWorker independentes, com identificadores distintos e a mesma fila.
- **Relação com o requisito:** Comprova suporte a mais de uma instância sem duplicar a API ou o ResultService.

**2. Distribuição de mensagens**

- **Arquivo:** `DockerCode/services/ExecutionWorker/JobConsumer.cs`
- **Linhas:** `69–82`
- **Método/componente:** BasicQos() / BasicConsume().
- **O que faz:** Cada Worker consome a fila RabbitMQ e mantém no máximo uma mensagem não confirmada por vez.
- **Relação com o requisito:** Comprova o consumo concorrente por instâncias separadas.

**3. Coordenação do Job**

- **Arquivo:** `DockerCode/services/ResultService/Program.cs`
- **Linhas:** `226–265`
- **Método/componente:** JobRepository.ClaimAsync().
- **O que faz:** Atribui um lease ao Worker que adquire o Job, impedindo aquisição simultânea do mesmo registro.
- **Relação com o requisito:** Comprova o controle de concorrência na persistência.

**4. Cenários de carga**

- **Arquivos e linhas:** `DockerCode/scripts/load-test.mjs` (`189–236`); `DockerCode/scripts/load-test.mjs` (`376–400`).
- **Método/componente:** runPhase() / main().
- **O que faz:** Executa Jobs concorrentes e mede vazão e latência em fases com diferentes níveis de concorrência.
- **Relação com o requisito:** Comprova a existência dos cenários; o script não altera o número de Workers nem mede ganho de escala horizontal.

**Resumo do requisito**

> O Docker Compose configura dois Workers independentes, e o RabbitMQ distribui mensagens aos consumidores. O ResultService coordena a aquisição dos Jobs. O script de carga testa concorrência, mas não comprova, sozinho, ganho de desempenho ao adicionar mais Workers.

---

### RNF04 — Eficiência de Rede Interna

**Descrição do requisito**

O acesso principal à aplicação web deve ser centralizado pelo proxy reverso (`infra/nginx/default.conf`), encaminhando as chamadas da interface para as instâncias da `SubmissionApi`.

**Por que esse requisito é importante?**

Oferece uma entrada principal para o frontend e encaminha as chamadas da interface às APIs de submissão.

**Evidências no projeto**

**1. Upstream e balanceamento**

- **Arquivo:** `DockerCode/infra/nginx/default.conf`
- **Linhas:** `1–5`
- **Método/componente:** upstream submission_api.
- **O que faz:** Agrupa `submission-api-1` e `submission-api-2` e aplica a política `least_conn`.
- **Relação com o requisito:** Comprova o encaminhamento para múltiplas instâncias da API.

**2. Rotas do proxy**

- **Arquivo:** `DockerCode/infra/nginx/default.conf`
- **Linhas:** `7–27`
- **Método/componente:** server / location /api/ / location /.
- **O que faz:** Encaminha chamadas `/api/` à SubmissionApi e serve a aplicação web estática.
- **Relação com o requisito:** Comprova a centralização do acesso principal à aplicação.

**3. Publicação da entrada web**

- **Arquivo:** `DockerCode/docker-compose.yml`
- **Linhas:** `141–150`
- **Método/componente:** frontend.
- **O que faz:** Expõe o frontend/Nginx na porta externa `8080`.
- **Relação com o requisito:** Comprova a porta de entrada web configurada.

**Resumo do requisito**

> O Nginx serve o frontend e encaminha as chamadas `/api/` para duas instâncias da SubmissionApi, usando `least_conn`. A aplicação web é publicada na porta 8080. Existe também uma porta direta da API para diagnóstico; portanto, não se afirma ocultação total da topologia.

---

### RNF05 — Verificabilidade Automatizada

**Descrição do requisito**

O ambiente distribuído deve suportar testes automatizados de fumo (`scripts/smoke-test.mjs`) e de carga (`scripts/load-test.mjs`) verificação automatizada sob demanda da arquitetura.

**Por que esse requisito é importante?**

Permite verificar automaticamente cenários funcionais e coletar indicadores sob diferentes níveis de concorrência.

**Evidências no projeto**

**1. Cenários de fumaça**

- **Arquivo:** `DockerCode/scripts/smoke-test.mjs`
- **Linhas:** `3–84`
- **Método/componente:** cases.
- **O que faz:** Define casos para quatro linguagens, erros, limite de memória, saída truncada e timeout.
- **Relação com o requisito:** Comprova a cobertura planejada dos principais comportamentos.

**2. Execução e verificações de fumaça**

- **Arquivo:** `DockerCode/scripts/smoke-test.mjs`
- **Linhas:** `88–166`
- **Método/componente:** submit() / waitForJob().
- **O que faz:** Submete códigos, consulta os Jobs, verifica status e saída e retorna erro se algum cenário falhar.
- **Relação com o requisito:** Comprova a lógica automatizada dos testes de fumaça.

**3. Medição de carga**

- **Arquivos e linhas:** `DockerCode/scripts/load-test.mjs` (`189–236`); `DockerCode/scripts/load-test.mjs` (`376–439`).
- **Método/componente:** runPhase() / main().
- **O que faz:** Executa requisições concorrentes em quatro fases e calcula métricas de vazão, fila e latência.
- **Relação com o requisito:** Comprova os testes automatizados sob demanda de carga.

**4. Comandos disponíveis**

- **Arquivo:** `DockerCode/package.json`
- **Linhas:** `6–11`
- **Método/componente:** scripts.test:smoke / scripts.test:load.
- **O que faz:** Disponibiliza comandos npm para iniciar os dois scripts.
- **Relação com o requisito:** Comprova como executar os testes manualmente.

**Resumo do requisito**

> O projeto inclui smoke tests que submetem programas e conferem o resultado, além de um teste de carga que executa Jobs concorrentes e calcula métricas. Ambos podem ser iniciados pelos scripts npm. Esses arquivos mostram suporte à verificação automatizada, não que os testes tenham sido executados nesta análise.

---

## Índice Rápido de Evidências

| Requisito | Principal arquivo | Linhas | O que faz |
|---|---|---|---|
| RF01 | `DockerCode/src/components/CodeEditor.jsx` | `232–253` | Editor Monaco para escrita do código |
| RF02 | `DockerCode/services/SubmissionApi/Program.cs` | `63–92` | Registra, publica e retorna HTTP 202 |
| RF03 | `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` | `96–120` | Cria/inicia contêiner e injeta TAR |
| RF04 | `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` | `161–185` | Tenta limpar contêiner e volume; registra falhas |
| RF05 | `DockerCode/services/ResultService/Program.cs` | `315–345` | Grava status e saída do Job no PostgreSQL |
| RF06 | `DockerCode/services/ExecutionWorker/Program.cs` | `17–29` | Endpoint de saúde do Worker |
| RNF01 | `DockerCode/services/ExecutionWorker/DockerEngineClient.cs` | `233–265` | Isolamento, memória, CPU e PIDs |
| RNF02 | `DockerCode/services/SubmissionApi/Program.cs` | `288–315` | Fila durável e publicação persistente |
| RNF03 | `DockerCode/docker-compose.yml` | `94–139` | Duas instâncias independentes de Worker |
| RNF04 | `DockerCode/infra/nginx/default.conf` | `1–23` | Balanceamento e proxy para a API |
| RNF05 | `DockerCode/package.json` | `6–11` | Comandos para os testes de fumaça e carga |
