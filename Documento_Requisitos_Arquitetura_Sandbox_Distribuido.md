**DOCUMENTO DE REQUISITOS E ARQUITETURA**

**Sandbox Distribuído de Execução de Código**

Tema 3 — Trabalho Prático de Sistemas Distribuídos

*Versão de planejamento arquitetural — sem implementação de código*

| Disciplina | Sistemas Distribuídos |
| :---- | :---- |
| **Tema** | Sandbox distribuído de execução de código |
| **Escopo tecnológico** | C\#/.NET, Docker, RabbitMQ, PostgreSQL, Terraform e Azure |
| **Objetivo** | Orientar implementação, apresentação ao professor e arguição do grupo |

Fonte principal: enunciado “Sistemas Distribuídos — Proposta de Trabalho Prático”, com foco nas regras gerais (pp. 1–2), Tema 3 (pp. 7–8) e critérios de avaliação (pp. 13–16).

# **Resumo das decisões arquiteturais**

| Princípio de projeto: Atender primeiro aos requisitos obrigatórios, preservar conceitos de Sistemas Distribuídos e reduzir o número de tecnologias e componentes que o grupo precisa dominar. |
| :---- |

| Decisão | Escolha para a primeira versão | Justificativa |
| :---- | :---- | :---- |
| Serviços de negócio | Submission API, Execution Worker e Result Service | Três serviços independentes, responsabilidades claras e escopo controlado. |
| Linguagem dos serviços | C\#/.NET 8 como padrão | Reduz a variedade tecnológica. O Worker pode ser Python se o grupo dominar melhor, sem alterar a arquitetura. |
| Broker | RabbitMQ | Funciona localmente em Docker Compose e pode ser levado para a VM Azure sem trocar tecnologia. |
| Persistência | Um PostgreSQL pertencente ao Result Service | Evita múltiplos bancos e mantém um único dono do estado persistente. |
| Réplicas | 2 Submission APIs atrás do Nginx \+ 2 Workers concorrentes | Atende balanceamento explícito e permite demonstrar falha de Worker. |
| Sandbox | Container Docker efêmero por Job | É a estratégia mais direta para isolamento acadêmico e limites de recursos. |
| Azure | 1 VM Linux provisionada por Terraform executando Docker Compose | Cumpre Azure \+ IaC com muito menos complexidade que AKS. |
| AKS | Fora da arquitetura mínima | Pode ser evolução/bônus; não é necessário para provar os conceitos centrais do trabalho. |

**Base no enunciado:** O enunciado exige pelo menos 3 serviços, comunicação síncrona e assíncrona, réplicas com balanceamento, idempotência, health checks, logs/correlation id, falha ao vivo, teste de carga e execução local. No Tema 3, também exige duas linguagens de execução, limites de recursos, isolamento, lease/heartbeat e Terraform na Azure.

# **Sumário**

* 1\. Introdução  
* 2\. Objetivo do Projeto  
* 3\. Escopo  
* 4\. Requisitos Funcionais  
* 5\. Requisitos Não Funcionais  
* 6\. Arquitetura Geral  
* 7\. Fluxo Principal de Execução  
* 8\. Comunicação entre Serviços  
* 9\. Estratégia de Mensageria  
* 10\. Lease e Heartbeat  
* 11\. Sandbox e Segurança  
* 12\. Estratégia para Python e C\#  
* 13\. Persistência  
* 14\. Estados do Job  
* 15\. Idempotência  
* 16\. Tolerância a Falhas  
* 17\. Réplicas e Balanceamento  
* 18\. Observabilidade  
* 19\. Infraestrutura  
* 20\. Terraform  
* 21\. Kubernetes / AKS  
* 22\. Docker Compose  
* 23\. Demonstração de Falha  
* 24\. Teste de Carga  
* 25\. Diagramas que Precisaremos Criar  
* 26\. ADRs  
* 27\. Divisão Inicial dos Serviços  
* 28\. Estrutura Inicial do Repositório  
* 29\. Plano de Implementação em 3 Semanas  
* 30\. Possíveis evoluções / bônus  
* 31\. Checklist de conformidade com o enunciado  
* 32\. Revisão final de complexidade

# **1\. Introdução**

Este documento define os requisitos e a arquitetura inicial de uma plataforma acadêmica de execução distribuída de código. A proposta é semelhante, em conceito, a um juiz online ou a uma versão simplificada do OneCompiler: o usuário envia um programa, o sistema transforma a solicitação em um Job, distribui esse Job para um pool de Workers e executa o código em um ambiente efêmero e isolado.

O desafio principal não é criar uma interface sofisticada. O foco é demonstrar conceitos de Sistemas Distribuídos: mensageria assíncrona, concorrência entre consumidores, tolerância a falhas, entrega at-least-once, idempotência, réplicas, balanceamento, observabilidade, isolamento de execução e infraestrutura reproduzível.

**Base no enunciado:** O enunciado afirma que a avaliação foca a arquitetura distribuída e aceita UI simples/cliente de linha de comando; para o Tema 3, a essência é distribuir Jobs entre Workers e sobreviver à queda de um Worker durante a execução.

# **2\. Objetivo do Projeto**

Construir um sistema distribuído capaz de receber códigos em Python e C\#, executá-los de forma controlada e devolver stdout, stderr, status e motivo de interrupção, mantendo o processamento mesmo quando um Worker falha.

* Distribuir Jobs de execução entre múltiplos Workers.  
* Impedir que código enviado pelo usuário tenha acesso irrestrito ao host, à rede ou aos recursos da máquina.  
* Garantir que a repetição de uma mensagem ou uma recuperação após falha não crie dois resultados finais válidos para o mesmo Job.  
* Permitir demonstrar, de forma observável, a queda de um Worker e a recuperação do Job por outra réplica.  
* Permitir subir todo o ambiente localmente com um único comando e criar/remover o ambiente Azure por Terraform.

# **3\. Escopo**

## **3.1 Dentro do escopo**

* Interface web simples para submissão e consulta de Jobs.  
* Execução de arquivo único Python (main.py).  
* Execução de programa C\# simples sobre template pré-preparado.  
* Criação, consulta e acompanhamento de Job.  
* Fila assíncrona de execução com RabbitMQ.  
* Pool com pelo menos dois Workers concorrentes.  
* Containers efêmeros de sandbox com limites de CPU, memória, processos e tempo.  
* Rede externa desabilitada para o sandbox e filesystem raiz somente leitura, com diretório temporário gravável.  
* Lease e heartbeat para detectar execução abandonada.  
* Idempotência e atualização condicional para impedir dois resultados finais.  
* Submission API com duas réplicas atrás de Nginx para atender explicitamente o requisito de balanceamento.  
* Logs JSON, Correlation-ID, Job ID, Worker ID e /health.  
* Ambiente local com Docker Compose.  
* Ambiente Azure simples provisionado por Terraform.  
* Teste de carga e roteiro de falha para apresentação.

## **3.2 Fora do escopo**

* Editor de código avançado, colaboração em tempo real ou autenticação completa de usuários.  
* Suporte a projetos C\# complexos, NuGet arbitrário ou múltiplos arquivos enviados pelo usuário.  
* Acesso do código executado à internet.  
* Prioridade de fila, cotas por usuário e cobrança.  
* Autoescalonamento com KEDA na primeira versão.  
* gVisor, Firecracker ou isolamento de microVM na primeira versão.  
* Cluster AKS como infraestrutura principal.  
* Garantia de “exactly-once execution”. O sistema garante apenas um resultado final persistido por Job; a execução física pode ser repetida após falhas.  
* Stack completa de observabilidade com Prometheus/Grafana/Jaeger na versão mínima.

| Observação: Os itens fora do escopo não são falhas do projeto. Eles são exclusões deliberadas para manter a entrega viável em aproximadamente três semanas. |
| :---- |

# **4\. Requisitos Funcionais**

| ID | Nome | Descrição | Comportamento esperado |
| :---- | :---- | :---- | :---- |
| RF01 | Submeter código | O usuário envia código e seleciona Python ou C\#. | A API valida a linguagem, gera um Job ID e inicia o processamento. |
| RF02 | Registrar Job | O sistema mantém o Job e seu estado persistidos. | O Job fica consultável mesmo após reinício dos serviços. |
| RF03 | Enfileirar execução | Após registrar o Job, a solicitação é publicada no broker. | O processamento não depende de a execução acontecer dentro da requisição HTTP. |
| RF04 | Consumir Jobs | Workers competem pelas mensagens da fila. | Um Worker disponível assume cada tentativa de execução. |
| RF05 | Assumir lease | Antes de executar, o Worker tenta obter o lease do Job. | Somente uma tentativa com lease válido pode atualizar o resultado final. |
| RF06 | Enviar heartbeat | O Worker renova periodicamente o lease durante a execução. | A ausência de heartbeat permite detectar que a execução foi abandonada. |
| RF07 | Executar Python | Executar um arquivo main.py em sandbox Python. | stdout, stderr e exit code são capturados. |
| RF08 | Executar C\# | Executar programa C\# simples em sandbox .NET. | O código é inserido em template local sem depender de internet. |
| RF09 | Aplicar limites | Executar o sandbox com limites de CPU, memória, processos e tempo. | Código abusivo é encerrado sem derrubar o Worker. |
| RF10 | Finalizar Job | Registrar sucesso, falha ou timeout. | O estado final e a saída ficam disponíveis para consulta. |
| RF11 | Consultar Job | O usuário consulta o estado de um Job pelo ID. | A resposta informa status e, quando finalizado, saída e motivo de falha. |
| RF12 | Recuperar Job abandonado | Detectar lease expirado e permitir nova tentativa. | Outro Worker pode processar o mesmo Job após falha da tentativa anterior. |
| RF13 | Ignorar duplicatas | Receber a mesma mensagem mais de uma vez sem gerar efeitos duplicados. | Tentativas sem direito ao lease são descartadas/confirmadas de forma segura. |
| RF14 | Health checks | Expor endpoint /health nos três serviços. | É possível verificar se cada serviço está ativo e pronto. |

# **5\. Requisitos Não Funcionais**

| ID | Requisito | Definição para o projeto |
| :---- | :---- | :---- |
| RNF01 | Arquitetura distribuída | No mínimo 3 serviços independentes, cada um em container próprio. |
| RNF02 | Comunicação híbrida | REST para operações síncronas e RabbitMQ para execução assíncrona. |
| RNF03 | Disponibilidade | Queda de um Worker não deve impedir a conclusão dos demais Jobs; API continua disponível se uma réplica cair. |
| RNF04 | Réplicas e balanceamento | Submission API com 2 réplicas atrás de Nginx; Workers com 2+ réplicas consumindo a mesma fila. |
| RNF05 | Idempotência | Duplicatas de mensagem ou tentativas repetidas não podem gerar dois resultados finais. |
| RNF06 | Timeout/retry | Chamadas remotas usam timeout; falhas transitórias elegíveis recebem retry com backoff. |
| RNF07 | Health | Submission API, Result Service e Worker expõem /health. |
| RNF08 | Observabilidade | Logs estruturados em JSON; Correlation-ID propagado em REST e mensagens; Job ID e Worker ID nos logs. |
| RNF09 | Isolamento | Cada execução usa container efêmero e descartável, separado do processo principal do Worker. |
| RNF10 | Segurança do sandbox | Usuário não-root, sem privilégios adicionais, sem rede externa, root filesystem read-only. |
| RNF11 | Limites de recursos | CPU, memória, número de processos e tempo máximo configurados por execução. |
| RNF12 | Persistência | Estado e resultados persistidos em PostgreSQL. |
| RNF13 | Tolerância a falhas | Worker perdido é detectado por heartbeat/lease e o Job pode ser reprocessado. |
| RNF14 | Execução local | Todo o ambiente sobe com um único docker compose up. |
| RNF15 | Infraestrutura como código | Terraform cria e remove o ambiente Azure com apply/destroy. |
| RNF16 | Teste de carga | O grupo mede vazão, latência p95 e erros com k6 ou Locust. |
| RNF17 | Filesystem do sandbox | Somente diretório temporário é gravável; restante do filesystem é somente leitura. |
| RNF18 | Rede do sandbox | Container de execução não acessa rede externa. |

# **6\. Arquitetura Geral**

A arquitetura mínima proposta contém três serviços de negócio e alguns componentes de infraestrutura. O objetivo é separar submissão, execução e estado/resultados sem criar microsserviços adicionais que o grupo não precisa.

| Componente | Tipo | Responsabilidade principal |
| :---- | :---- | :---- |
| Web/Nginx | Infraestrutura | Serve a interface estática e balanceia /api entre duas réplicas da Submission API. |
| Submission API | Serviço 1 | Recebe submissões, valida linguagem, solicita criação do Job ao Result Service, publica no RabbitMQ e consulta status. |
| RabbitMQ | Infraestrutura | Fila de Jobs; entrega at-least-once; redelivery de mensagens não confirmadas. |
| Execution Worker | Serviço 2 | Consome Job, solicita lease, inicia sandbox, envia heartbeat, coleta saída e envia resultado. |
| Sandbox container | Efêmero | Executa código Python ou C\# com restrições. É criado e destruído por Job. |
| Result Service | Serviço 3 | É o dono do estado do Job: criação, claim/lease, heartbeat, finalização, consulta e recuperação de leases expirados. |
| PostgreSQL | Infraestrutura | Persistência única dos Jobs, pertencente logicamente ao Result Service. |

Usuário  
  ↓ HTTP  
Nginx / Front-end  
  ↓ balanceamento REST  
Submission API (2 réplicas) ──REST──\> Result Service ──SQL──\> PostgreSQL  
        │                              ↑  
        └── mensagem assíncrona ──\> RabbitMQ ──\> Workers (2+)  
                                                   │  
                                                   ├── REST: claim/heartbeat/finalização ──\> Result Service  
                                                   └── cria container efêmero ──\> sandbox-python | sandbox-dotnet

| Combinação evitada: Não recomendamos juntar Submission API e Result Service na primeira definição porque perderíamos uma separação clara entre entrada pública e coordenação/persistência de execução. Também não recomendamos criar um quarto serviço só para lease/recovery; esse comportamento cabe no Result Service. |
| :---- |

# **7\. Fluxo Principal de Execução**

1. O usuário envia código e linguagem para POST /jobs.  
2. O Nginx encaminha a requisição para uma das réplicas da Submission API.  
3. A Submission API valida tamanho/formato básico e verifica se a linguagem é Python ou C\#.  
4. A Submission API gera Correlation-ID (se não existir) e solicita ao Result Service a criação do Job com status QUEUED.  
5. O Result Service persiste o Job no PostgreSQL e devolve o Job ID.  
6. A Submission API publica uma mensagem no RabbitMQ contendo, no mínimo, Job ID, linguagem e Correlation-ID. O código pode permanecer no banco para evitar mensagens grandes.  
7. Um Worker recebe a mensagem e chama o Result Service para tentar obter o lease do Job.  
8. O Result Service faz atualização condicional. Se o Job estiver disponível, registra RUNNING, Worker ID, lease\_until e devolve autorização de execução.  
9. O Worker lê os dados necessários do Job, escolhe sandbox-python ou sandbox-dotnet e cria um container efêmero com restrições.  
10. Enquanto o código executa, o Worker envia heartbeats para renovar o lease.  
11. O Worker captura stdout, stderr, exit code e motivo de término. O timeout externo encerra o sandbox se necessário.  
12. O Worker chama o Result Service para finalizar o Job. A finalização é condicional ao lease/tentativa ainda ser válida.  
13. O Result Service persiste o estado final (SUCCEEDED, FAILED ou TIMEOUT).  
14. Somente depois de persistir o resultado, o Worker confirma (ack) a mensagem do RabbitMQ.  
15. O usuário consulta GET /jobs/{id}; a Submission API busca o estado no Result Service e devolve a resposta.

| Ponto distribuído central: A mensagem pode reaparecer após falha. Por isso, “mensagem recebida” não significa “direito de executar”. O direito é concedido pelo claim/lease atômico no Result Service. |
| :---- |

# **8\. Comunicação entre Serviços**

| Origem | Destino | Tipo | Tecnologia | Motivo |
| :---- | :---- | :---- | :---- | :---- |
| Navegador | Nginx / Submission API | Síncrona | HTTP/REST | O usuário precisa de resposta imediata para submeter e consultar Jobs. |
| Submission API | Result Service | Síncrona | HTTP/REST | Criar Job e consultar estado requerem confirmação imediata. |
| Submission API | RabbitMQ | Assíncrona | AMQP | A execução pode demorar e deve ser desacoplada da requisição web. |
| RabbitMQ | Execution Worker | Assíncrona | AMQP | Distribui Jobs entre Workers concorrentes e permite redelivery. |
| Execution Worker | Result Service | Síncrona | HTTP/REST | Claim, heartbeat e finalização precisam de resposta consistente. |
| Result Service | PostgreSQL | Síncrona | SQL | Persistência atômica do estado do Job. |
| Result Service | RabbitMQ | Assíncrona | AMQP | Somente para recuperação de Job cujo lease expirou, quando necessário. |

Justificativa geral: REST é usado quando o chamador precisa saber imediatamente se uma operação de estado foi aceita. RabbitMQ é usado quando o trabalho pode ser executado posteriormente, por qualquer Worker disponível, e precisa sobreviver a quedas temporárias de consumidores.

# **9\. Estratégia de Mensageria**

## **9.1 Fila de Jobs**

A primeira versão pode usar uma única fila, por exemplo execution.jobs. Cada mensagem identifica o Job. Workers usam o padrão competing consumers: todos consomem a mesma fila e o RabbitMQ entrega cada mensagem disponível a um consumidor.

## **9.2 Confirmação e entrega at-least-once**

O Worker utiliza confirmação manual. A mensagem só recebe ack depois que o resultado final foi aceito pelo Result Service. Se o Worker cair antes do ack, a mensagem pode voltar para a fila. Esse comportamento caracteriza entrega at-least-once: a mensagem será processada pelo menos uma vez, mas pode aparecer mais de uma vez.

## **9.3 Duplicatas e idempotência**

Duplicatas são esperadas e não devem ser tratadas como erro raro. O Job ID é a chave de idempotência. Ao receber uma mensagem, o Worker tenta claim no Result Service; se o Job já estiver finalizado ou possuir lease válido de outra tentativa, o claim é recusado e o Worker não produz novo resultado.

## **9.4 Retry e DLQ**

Retries são aplicados apenas a falhas transitórias de infraestrutura, como timeout temporário ao Result Service ou indisponibilidade momentânea do broker. O intervalo cresce com backoff para evitar sobrecarga. Para a versão mínima, uma Dead Letter Queue é útil para mensagens estruturalmente inválidas ou que excedam um limite configurado de tentativas de infraestrutura. Erros do código do usuário não devem ir para DLQ; eles finalizam o Job como FAILED ou TIMEOUT.

| Sugestão nossa: Usar publisher confirms no RabbitMQ e mensagem persistente melhora a segurança de publicação sem exigir Outbox. O padrão Outbox seria uma evolução possível, não um requisito explícito do Tema 3\. |
| :---- |

# **10\. Lease e Heartbeat**

## **10.1 Lease**

Lease é uma autorização temporária para um Worker atuar sobre um Job. Ao fazer claim, o Worker recebe o direito de executar até um horário lease\_until. Esse direito não é permanente: precisa ser renovado.

## **10.2 Heartbeat**

Heartbeat é um sinal periódico enviado pelo Worker ao Result Service enquanto a execução está ativa. Cada heartbeat estende lease\_until. Se os sinais pararem, o sistema conclui que aquela tentativa pode ter sido perdida.

## **10.3 Detecção e recuperação**

* O Result Service executa uma rotina periódica simples para localizar Jobs RUNNING com lease expirado.  
* O Job expirado volta logicamente para QUEUED e uma mensagem de recuperação com o mesmo Job ID é publicada.  
* Outro Worker consome a mensagem e tenta novo claim.  
* Se a mensagem original também reaparecer, haverá duplicata; o claim condicional garante que apenas uma tentativa obtenha o lease.

## **10.4 Evitando resultado de Worker antigo**

Além de Job ID e Worker ID, recomenda-se que cada claim gere um lease\_token (UUID) ou número de tentativa. A finalização só é aceita se status \= RUNNING e o token enviado for o mesmo token ativo. Assim, um Worker antigo que “volte” depois de perder o lease não consegue sobrescrever o resultado da tentativa atual.

| Recomendação de implementação, não exigência do professor: O lease\_token adiciona pouca complexidade e torna a demonstração de corrida entre tentativas muito mais segura. Se o grupo preferir não usá-lo, deve ao menos validar Worker ID, status e lease ainda válido em uma atualização condicional. |
| :---- |

# **11\. Sandbox e Segurança**

Código enviado por usuário é considerado não confiável. Ele nunca deve rodar no mesmo processo do Worker. O Worker cria um container efêmero, inicia a execução, coleta a saída e destrói o container ao final.

| Controle | Estratégia |
| :---- | :---- |
| Usuário do container | Executar como usuário não-root definido na imagem. |
| Privilégios | Não usar \--privileged; remover capabilities desnecessárias; no-new-privileges como recomendação. |
| CPU | Aplicar quota de CPU por container. |
| Memória | Aplicar limite máximo de memória; o host encerra o container em caso de excesso. |
| Processos | Aplicar limite de PIDs para evitar fork bomb. |
| Tempo | Worker aplica timeout externo e mata/remove o container após o limite. |
| Rede | Usar rede desabilitada para o sandbox (equivalente a network none). |
| Filesystem | Root filesystem somente leitura. |
| Diretório temporário | Montar /tmp ou /workspace como tmpfs/volume temporário gravável. |
| Ciclo de vida | Um container por tentativa; sempre removido após execução. |

A API principal não deve acessar o Docker socket porque qualquer vulnerabilidade nessa API poderia virar controle do host Docker. Na arquitetura mínima, somente o Worker — componente interno e restrito — precisa orquestrar containers de sandbox. O sandbox em si nunca recebe o socket Docker.

| Limitação consciente: Montar o Docker socket no Worker é simples para laboratório, mas dá ao Worker poder elevado sobre o daemon. Para um produto real seria preferível um executor dedicado, socket proxy com permissões mínimas ou orquestração por Kubernetes/gVisor. Para o trabalho, documentar esse trade-off é suficiente. |
| :---- |

# **12\. Estratégia para Python e C\#**

## **12.1 Imagem sandbox-python**

* Base com Python instalado.  
* Usuário não-root.  
* Recebe o código como /workspace/main.py em diretório temporário.  
* Executa python /workspace/main.py.  
* Não instala pacotes durante a execução e não usa rede.

## **12.2 Imagem sandbox-dotnet**

* Base com .NET SDK necessário para compilar/executar o programa simples.  
* Imagem contém um template de Console previamente preparado e restaurado no build da imagem.  
* Para cada Job, o Worker copia o template para /workspace e substitui Program.cs pelo código recebido.  
* A execução usa restore previamente preparado e não depende da internet.  
* Projetos multi-arquivo, pacotes NuGet arbitrários e upload de solução ficam fora do escopo inicial.

O Worker escolhe a imagem pela propriedade language do Job. Uma tabela interna simples é suficiente: python → sandbox-python; csharp → sandbox-dotnet. Essa abordagem atende o requisito de duas linguagens e evita transformar o projeto em uma plataforma completa de build.

# **13\. Persistência**

Um único PostgreSQL é suficiente para a versão inicial. Ele pertence logicamente ao Result Service; outros serviços não acessam suas tabelas diretamente. Isso reduz acoplamento e evita múltiplos bancos sem necessidade.

| Campo | Tipo conceitual | Objetivo |
| :---- | :---- | :---- |
| id | UUID / PK | Identificador único e chave de idempotência. |
| language | string/enum | python ou csharp. |
| source\_code | text | Código enviado pelo usuário. |
| status | string/enum | QUEUED, RUNNING, SUCCEEDED, FAILED ou TIMEOUT. |
| created\_at | timestamp | Momento de criação. |
| started\_at | timestamp nullable | Início da tentativa aceita. |
| finished\_at | timestamp nullable | Fim do Job. |
| worker\_id | string nullable | Worker que possui o lease atual. |
| lease\_until | timestamp nullable | Validade atual do lease. |
| lease\_token | UUID nullable | Recomendação: identifica a tentativa/lease atual. |
| stdout | text nullable | Saída padrão limitada a tamanho razoável. |
| stderr | text nullable | Saída de erro limitada. |
| exit\_code | integer nullable | Código de saída quando aplicável. |
| failure\_reason | string nullable | TIMEOUT, MEMORY\_LIMIT, RUNTIME\_ERROR, INFRA\_ERROR etc. |
| correlation\_id | string | Correlação do fluxo para logs. |

| Sugestão nossa: Limitar o tamanho de stdout/stderr evita que um programa gere saída infinita e consuma o banco. Isso é boa prática, mas não é requisito explícito do enunciado. |
| :---- |

# **14\. Estados do Job**

A máquina de estados deve ser pequena. Não é necessário criar estados para cada detalhe de infraestrutura.

QUEUED ──claim válido──\> RUNNING ──exit 0──\> SUCCEEDED  
                         ├──erro/limite memória──\> FAILED  
                         └──tempo excedido───────\> TIMEOUT

RUNNING ──lease expirado──\> QUEUED  (nova tentativa)

| Estado | Significado | Transições principais |
| :---- | :---- | :---- |
| QUEUED | Job persistido e disponível para execução. | RUNNING |
| RUNNING | Um Worker possui lease ativo. | SUCCEEDED, FAILED, TIMEOUT, QUEUED por lease expirado |
| SUCCEEDED | Execução concluída com sucesso. | Terminal |
| FAILED | Falha do programa ou limite/erro não classificado como timeout. | Terminal |
| TIMEOUT | Tempo máximo ultrapassado. | Terminal |

# **15\. Idempotência**

Idempotência significa que repetir a mesma operação não produz efeitos duplicados. Neste projeto ela é essencial porque RabbitMQ pode redeliver mensagens.

* Job ID é único e aparece em todas as mensagens e operações.  
* Claim usa UPDATE condicional no banco; somente um Worker obtém a transição válida para RUNNING.  
* Mensagem de Job finalizado não inicia nova execução; o Worker confirma a mensagem e encerra o processamento.  
* Finalização é condicional ao status RUNNING e ao lease/tentativa ativa.  
* A tabela possui uma única linha por Job, portanto “resultado final” não é inserido como registro independente a cada tentativa.

| Importante para a apresentação: At-least-once não impede execução física duplicada em todos os cenários. O objetivo é tornar os efeitos persistidos idempotentes: no máximo um resultado final aceito por Job. |
| :---- |

# **16\. Tolerância a Falhas**

| Falha | Comportamento | Resultado esperado |
| :---- | :---- | :---- |
| Worker cai | Mensagem pode voltar à fila sem ack; heartbeat para; lease expira; outro Worker obtém novo lease e reexecuta. | Job termina sem depender do Worker original. |
| Broker indisponível | Submission API aplica timeout/retry com backoff. Se não conseguir publicar, a submissão falha de forma controlada; não inicia execução silenciosamente. | Usuário recebe erro temporário e pode ressubmeter. |
| Banco indisponível | Result Service retorna erro; API/Worker fazem retry apenas para falha transitória. Worker não dá ack sem persistência do resultado. | Evita confirmar trabalho que não foi salvo. |
| Job excede tempo | Worker encerra o sandbox e finaliza TIMEOUT. | Worker continua saudável. |
| Job excede memória | Runtime/container é encerrado pelo limite; Worker detecta término anormal e registra FAILED com motivo de limite de memória. | Host e Worker continuam operacionais. |
| Mensagem duplicada | Novo claim é recusado se Job já finalizou ou tem lease válido. | Sem segundo resultado final. |
| API replica cai | Nginx direciona novas requisições para a réplica disponível. | Entrada do sistema permanece acessível. |

Uma falha que a arquitetura mínima não tenta resolver é a perda completa da única VM Azure ou do único PostgreSQL. Alta disponibilidade multi-VM/multi-zona aumentaria muito o escopo e não é necessária para a demonstração central do trabalho.

# **17\. Réplicas e Balanceamento**

Para atender explicitamente o requisito geral de “2 ou mais réplicas atrás de um balanceador”, a Submission API terá duas réplicas e o Nginx fará reverse proxy/load balancing. Essa escolha é mais clara para avaliação do que tentar considerar o broker como balanceador dos Workers.

* submission-api-1 e submission-api-2: stateless e equivalentes.  
* Nginx: expõe um único endpoint e distribui requisições entre as duas réplicas.  
* worker-1 e worker-2: competem pela fila do RabbitMQ; não precisam de balanceador HTTP para o fluxo de Jobs.  
* Result Service: uma réplica na versão mínima, porque ele centraliza transições atômicas no PostgreSQL e não precisa ser altamente disponível para a demo.

Se o grupo optar futuramente por AKS, o Service do Kubernetes substitui o Nginx para balancear as réplicas da API. A lógica da aplicação não muda.

# **18\. Observabilidade**

A versão mínima deve permitir responder três perguntas durante a demo: “qual Job?”, “qual Worker?” e “o que aconteceu?”. Para isso, logs estruturados são mais importantes que uma stack visual complexa.

| Elemento | Onde | Uso |
| :---- | :---- | :---- |
| /health | Todos os serviços | Indica liveness/readiness básica e dependências essenciais conforme definido pelo grupo. |
| Logs JSON | Todos | Campos: timestamp, level, service, message, correlation\_id, job\_id, worker\_id quando existir. |
| Correlation-ID | REST \+ mensagem | Criado na entrada se ausente; propagado em X-Correlation-ID e header da mensagem. |
| Job ID | Fluxo de execução | Permite seguir uma execução específica ponta a ponta. |
| Worker ID | Worker | Mostra qual réplica assumiu, perdeu ou concluiu o Job. |

| Opcional: OpenTelemetry pode ser adicionado depois para traces distribuídos, mas não é necessário para a primeira versão. O enunciado considera métricas/tracing excelência, não núcleo obrigatório geral. |
| :---- |

# **19\. Infraestrutura**

## **19.1 Ambiente local**

O ambiente principal de desenvolvimento e correção roda em uma única máquina com Docker Compose. Isso é obrigatório pelo enunciado e deve ser tratado como “caminho dourado” para a apresentação: simples, reproduzível e sem dependência de internet.

* nginx/web  
* submission-api (2 réplicas)  
* result-service  
* worker (2 réplicas)  
* rabbitmq  
* postgres  
* sandbox-python e sandbox-dotnet como imagens locais

## **19.2 Ambiente Azure**

Para cumprir a exigência específica do Tema 3 de Terraform na Azure sem adicionar Kubernetes, a proposta mínima usa uma VM Linux provisionada por Terraform. Nessa VM o mesmo Docker Compose é executado. O objetivo do ambiente cloud é demonstrar IaC e portabilidade, não alta disponibilidade de produção.

* Resource Group.  
* Virtual Network/Subnet.  
* Network Security Group com portas mínimas necessárias.  
* Public IP apenas para acesso de demonstração, se necessário.  
* Uma Linux VM de tamanho compatível com o crédito de estudante.  
* Disco gerenciado da VM.

| Distinção importante do enunciado: A arquitetura sugerida do Tema 3 menciona Workers em 2+ nós ou VMs, mas a lista de requisitos mínimos não exige máquinas físicas distintas. Na versão mínima propomos 2 Workers em containers. Se o professor exigir aderência também à sugestão de distribuição física, a evolução mais simples é provisionar uma segunda VM de Worker por Terraform. |
| :---- |

| Decisão de escopo: AKS não é necessário para a arquitetura principal. A VM permite executar exatamente a mesma composição local, reduzindo divergência entre ambientes. |
| :---- |

# **20\. Terraform**

Terraform descreve a infraestrutura Azure de forma declarativa. O grupo deve conseguir criar e remover o ambiente de forma reproduzível.

| Comando | Papel no projeto |
| :---- | :---- |
| terraform init | Inicializa o diretório, provider Azure e dependências. |
| terraform plan | Mostra o que será criado/alterado sem executar mudanças. |
| terraform apply | Provisiona os recursos Azure definidos. |
| terraform destroy | Remove os recursos provisionados para evitar consumo de crédito. |

O Terraform administra os recursos de infraestrutura, não o código da aplicação. A implantação do Docker Compose pode ser feita por script de bootstrap/cloud-init simples ou passo documentado no README, desde que o grupo consiga explicar a separação entre provisionamento e aplicação.

# **21\. Kubernetes / AKS**

AKS é tecnicamente adequado para escalar Workers e criar Pods efêmeros, mas aumenta significativamente o número de conceitos, manifests e pontos de falha. Como o requisito do Tema 3 aceita Azure com VMs e o núcleo geral exige que tudo rode com Compose, não recomendamos AKS como primeira entrega.

| Conceito Kubernetes | Mapeamento caso AKS seja adotado depois |
| :---- | :---- |
| Deployment | Submission API, Result Service e Worker. |
| Service | Balanceamento interno/externo da Submission API e Result Service. |
| ConfigMap | Configurações não sensíveis. |
| Secret | Credenciais de banco/broker. |
| Job/Pod efêmero | Cada execução de código poderia virar um Pod/Job isolado. |

| Possível evolução: AKS faz mais sentido se o grupo quiser explorar KEDA ou isolamento por Pod como bônus. Ele não deve bloquear a entrega mínima. |
| :---- |

# **22\. Docker Compose**

O docker-compose.yml deve permitir iniciar o sistema completo com um comando. Conceitualmente, ele contém:

services:  
  nginx-web  
  submission-api-1  
  submission-api-2  
  result-service  
  worker-1  
  worker-2  
  rabbitmq  
  postgres

\# sandbox-python e sandbox-dotnet são imagens usadas sob demanda pelo Worker,  
\# não serviços permanentemente ativos.

* Health checks para serviços e infraestrutura.  
* Rede interna para comunicação entre componentes.  
* Volume persistente do PostgreSQL durante desenvolvimento.  
* Variáveis de ambiente para URLs e credenciais.  
* Dependências de inicialização apenas como conveniência; readiness real deve ser validada por health/retry.

# **23\. Demonstração de Falha**

O roteiro abaixo deve ser ensaiado e executado ao vivo. Ele prova não apenas que “volta a funcionar”, mas o mecanismo distribuído interno.

1\. Iniciar o ambiente com docker compose up e mostrar /health dos três serviços.

2\. Mostrar que existem duas réplicas da Submission API e pelo menos dois Workers.

3\. Submeter aproximadamente 50 Jobs válidos, preferencialmente com duração suficiente para observar processamento concorrente.

4\. Acompanhar logs por Job ID/Worker ID e a fila do RabbitMQ.

5\. Durante o pico, interromper worker-1 enquanto ele possui Jobs RUNNING.

6\. Mostrar que o heartbeat desse Worker deixa de chegar e que o lease do Job termina.

7\. Mostrar a recuperação: a mensagem reaparece ou uma mensagem de recuperação é publicada, worker-2 obtém novo lease e executa o Job.

8\. Ao final, executar uma verificação que conte todos os Job IDs e confirme exatamente um estado final por Job.

9\. Exibir um Job que foi tentado por mais de um Worker, mas terminou com apenas um resultado final aceito.

10\. Submeter um programa com loop infinito e mostrar que ele termina como TIMEOUT.

11\. Submeter um programa que ultrapasse memória e mostrar que o sandbox é encerrado/fracassa sem derrubar o Worker.

12\. Executar um novo Job normal depois desses casos para provar que o Worker permanece saudável.

| Critério de sucesso da demo: Não basta mostrar que o Job terminou. O grupo deve explicar: ack manual, redelivery/recuperação, lease expirado, claim atômico e idempotência da finalização. |
| :---- |

# **24\. Teste de Carga**

Recomendação: usar k6 por ser simples de executar e gerar métricas HTTP. O teste pode submeter Jobs pequenos e consultar seus estados até finalização. O objetivo é medir o comportamento do sistema, não “bater recorde”.

| Métrica | Como medir | Por que importa |
| :---- | :---- | :---- |
| Jobs submetidos | Contagem total de POST /jobs. | Volume do teste. |
| Jobs/s | Taxa de submissão e/ou conclusão. | Vazão. |
| Latência média da API | Tempo de POST/GET. | Custo do caminho síncrono. |
| p95 da API | 95% das requisições abaixo desse tempo. | Métrica obrigatória do enunciado. |
| Tempo fim a fim do Job | Criação até estado final. | Inclui fila \+ execução. |
| Taxa de erro | HTTP 5xx, falhas de infraestrutura, timeouts. | Estabilidade. |
| Tamanho/lag da fila | RabbitMQ Management ou métrica simples. | Mostra se Workers acompanham a demanda. |

| Etapa | Sugestão de execução |
| :---- | :---- |
| Baseline | Carga baixa para confirmar comportamento correto. |
| Carga crescente | Aumentar gradualmente requisições/Jobs concorrentes. |
| Pico | Rajada de Jobs para observar crescimento da fila. |
| Falha durante carga | Opcionalmente repetir matando um Worker para comparar recuperação. |
| Relatório | Registrar vazão, p95, erros, fila e interpretação do gargalo observado. |

Nenhum valor de desempenho é assumido neste documento. Os números reais devem ser coletados na implementação.

# **25\. Diagramas que Precisaremos Criar**

## **25.1 C4 — Contexto**

Mostrar o usuário e o “Sistema Sandbox Distribuído” como uma única caixa, com a finalidade de executar código Python/C\# de forma isolada. Não mostrar detalhes de containers nesse nível.

\[Usuário/Aluno\] ── envia código / consulta resultado ──\> \[Sandbox Distribuído de Execução de Código\]

## **25.2 C4 — Containers**

Mostrar os containers lógicos de software e suas relações: Web/Nginx, Submission API, RabbitMQ, Workers, Result Service, PostgreSQL e sandboxes efêmeros.

\[Browser\]  
   │ HTTP  
\[Web/Nginx\]  
   │ REST / balanceamento  
\[Submission API x2\] ──REST──\> \[Result Service\] ──SQL──\> \[PostgreSQL\]  
        │                            ↑  
        └──AMQP──\> \[RabbitMQ\] ──AMQP──\> \[Worker x2+\]  
                                         │  
                                         └── cria ──\> \[Sandbox efêmero Python/.NET\]

## **25.3 Diagrama de sequência**

O fluxo deve incluir persistência do Job, publicação, claim, lease, execução, heartbeat, finalização e ack. Uma segunda sequência curta pode mostrar queda do Worker e recuperação.

Usuário \-\> Submission API: POST /jobs  
Submission API \-\> Result Service: create(QUEUED)  
Result Service \-\> PostgreSQL: INSERT  
Submission API \-\> RabbitMQ: publish(job\_id)  
RabbitMQ \-\> Worker A: deliver  
Worker A \-\> Result Service: claim(job\_id)  
Result Service \-\> PostgreSQL: UPDATE ... WHERE status=QUEUED  
Worker A \-\> Sandbox: start  
loop enquanto executa  
  Worker A \-\> Result Service: heartbeat  
end  
Worker A \-\> Result Service: complete(result)  
Result Service \-\> PostgreSQL: conditional UPDATE final  
Worker A \-\> RabbitMQ: ack  
Usuário \-\> Submission API: GET /jobs/{id}

# **26\. ADRs**

O enunciado exige de 3 a 5 ADRs. Abaixo estão cinco decisões coerentes com a arquitetura mínima.

## **ADR-001 — RabbitMQ como broker**

| Item | Conteúdo |
| :---- | :---- |
| Contexto | O sistema precisa de mensageria assíncrona local e em Azure. |
| Decisão | Usar RabbitMQ em ambos os ambientes. |
| Alternativas | Azure Service Bus; Redis Streams; Kafka. |
| Vantagens | Mesma tecnologia em Compose e Azure; simples para competing consumers; management UI útil na demo. |
| Desvantagens | Precisamos operar o RabbitMQ na VM Azure; não é serviço gerenciado. |
| Trade-off aceito | Preferimos simplicidade e paridade de ambiente a um broker gerenciado. |

## **ADR-002 — Azure VM \+ Docker Compose em vez de AKS**

| Item | Conteúdo |
| :---- | :---- |
| Contexto | O Tema 3 exige Terraform/Azure, mas o cronograma é de três semanas. |
| Decisão | Provisionar uma VM Linux com Terraform e executar a mesma composição local. |
| Alternativas | AKS; múltiplas VMs; Azure Container Apps. |
| Vantagens | Menos manifests, menor curva de aprendizado, mesma topologia da demo local. |
| Desvantagens | Não demonstra orquestração Kubernetes nem alta disponibilidade de infraestrutura. |
| Trade-off aceito | Preferimos completar resiliência da aplicação a gastar tempo com orquestração cloud. |

## **ADR-003 — Container Docker efêmero por execução**

| Item | Conteúdo |
| :---- | :---- |
| Contexto | Código do usuário não pode rodar no processo do Worker e precisa de limites. |
| Decisão | Criar e destruir container sandbox por tentativa. |
| Alternativas | Processo local com ulimit; gVisor; Firecracker; Pod Kubernetes. |
| Vantagens | Fácil de explicar, limita recursos e isola filesystem/rede. |
| Desvantagens | Worker precisa controlar Docker; isolamento não é equivalente a microVM. |
| Trade-off aceito | Aceitamos risco controlado de laboratório para reduzir complexidade. |

## **ADR-004 — Idempotência por Job ID \+ claim/finalização condicional**

| Item | Conteúdo |
| :---- | :---- |
| Contexto | Mensagens at-least-once podem ser duplicadas e Workers podem competir. |
| Decisão | Usar Job ID único e transições atômicas no PostgreSQL, preferencialmente com lease\_token. |
| Alternativas | Locks distribuídos no Redis; exactly-once via broker; tabela separada de deduplicação. |
| Vantagens | Poucos componentes e garantia forte no ponto crítico. |
| Desvantagens | Pode haver execução física repetida; banco é autoridade de estado. |
| Trade-off aceito | Aceitamos reexecução eventual, mas nunca dois resultados finais aceitos. |

## **ADR-005 — Um PostgreSQL pertencente ao Result Service**

| Item | Conteúdo |
| :---- | :---- |
| Contexto | Múltiplos bancos aumentariam configuração sem necessidade acadêmica. |
| Decisão | Centralizar estado de Jobs no Result Service, com acesso ao banco apenas por ele. |
| Alternativas | Banco por serviço; banco compartilhado acessado diretamente por todos. |
| Vantagens | Baixa complexidade, responsabilidade clara de dados. |
| Desvantagens | Result Service vira ponto central de coordenação e persistência. |
| Trade-off aceito | Aceitamos centralização de estado para manter o projeto implementável e coerente. |

# **27\. Divisão Inicial dos Serviços**

| Serviço | Responsabilidades | Estado próprio |
| :---- | :---- | :---- |
| Serviço 1 — Submission API | API pública: valida submissão, cria Correlation-ID, solicita criação/consulta de Job no Result Service, publica mensagens no broker. | Stateless; sem acesso direto ao PostgreSQL. |
| Serviço 2 — Execution Worker | Consome fila, claim, heartbeat, inicia sandbox, controla timeout, captura saída, finaliza Job e dá ack. Exposição mínima de /health. | Estado efêmero da tentativa atual; sem banco próprio. |
| Serviço 3 — Result Service | Dono do ciclo de vida do Job, persistência, leases, heartbeats, finalização idempotente, consulta e recuperação de leases expirados. | PostgreSQL. |

Essa divisão atende o mínimo de três serviços independentes sem criar serviços artificiais. Nginx, RabbitMQ e PostgreSQL são componentes de infraestrutura, não contados como serviços de negócio.

# **28\. Estrutura Inicial do Repositório**

/src  
  /submission-api  
  /result-service  
  /worker  
  /frontend

/sandbox-images  
  /python  
    Dockerfile  
  /dotnet  
    Dockerfile  
    /template

/infra  
  /terraform  
  /nginx  
  /kubernetes        \# somente se AKS for explorado depois

/tests  
  /load  
  /failure

/docs  
  /adr  
  /diagrams  
  /reports

docker-compose.yml  
.env.example  
README.md

A pasta /kubernetes pode nem existir na primeira semana. Criá-la apenas se o grupo decidir implementar AKS evita documentação vazia ou compromisso prematuro.

# **29\. Plano de Implementação em 3 Semanas**

## **29.1 Semana 1 — Arquitetura e esqueleto**

* Fechar este documento e diagramas C4 iniciais.  
* Criar ADR-001 e ADR-002.  
* Criar repositório, Dockerfiles e docker-compose.yml.  
* Subir PostgreSQL, RabbitMQ, Nginx, 2 APIs, Result Service e 2 Workers.  
* Implementar /health em todos os serviços.  
* Implementar “hello world” síncrono Submission API → Result Service e assíncrono Submission API → RabbitMQ → Worker.  
* Checkpoint: docker compose up funcional, broker ativo e pelo menos dois serviços trocando mensagens.

## **29.2 Semana 2 — Fluxo principal**

* Persistência de Job e máquina de estados.  
* Submissão Python e C\# básica.  
* Imagens sandbox-python e sandbox-dotnet.  
* Claim/lease/heartbeat.  
* Execução com limites de recursos e captura de saída.  
* Idempotência de claim e finalização.  
* Duas réplicas da API balanceadas por Nginx.  
* Dois Workers concorrentes.  
* Primeiro teste de falha: matar Worker durante execução, mesmo que a recuperação ainda precise ajustes.

## **29.3 Semana 3 — Resiliência, testes e apresentação**

* Ajustar recovery de lease e duplicatas.  
* Adicionar retries com backoff e timeouts nas chamadas remotas.  
* Logs JSON \+ Correlation-ID ponta a ponta.  
* Executar casos de loop infinito e memória excessiva.  
* Criar k6/Locust e relatório com vazão e p95.  
* Finalizar 3–5 ADRs e diagramas.  
* Criar Terraform para Azure VM e validar apply/destroy.  
* Documentar README e roteiro de falha.  
* Ensaiar demo de 10 minutos e arguição.

| Regra de priorização: Se houver atraso, cortar primeiro qualquer bônus/AKS/telemetria avançada. Não cortar idempotência, lease/heartbeat, limites de sandbox, falha ao vivo, Docker Compose ou teste de carga. |
| :---- |

# **30\. Possíveis evoluções / bônus**

| Evolução | Valor | Quando considerar |
| :---- | :---- | :---- |
| KEDA | Escalar Workers com base no tamanho da fila. | Somente após fluxo principal e testes de falha estarem estáveis. |
| Prioridade de fila | Jobs urgentes antes dos comuns. | Depois da fila única funcionar e ser mensurável. |
| Cotas por usuário | Evitar monopolização de recursos. | Exige autenticação/identidade; manter como bônus. |
| gVisor | Isolamento mais forte que container Docker padrão. | Se houver tempo e ambiente compatível. |
| Cache de imagens | Reduz tempo de inicialização de sandboxes. | Após medir que pull/start de imagem é gargalo. |
| OpenTelemetry | Tracing ponta a ponta. | Se logs JSON já estiverem corretos. |
| AKS | Orquestração e pods efêmeros. | Se o grupo quiser transformar o deploy cloud em bônus avançado. |
| Outbox | Elimina janela entre persistência do Job e publicação da mensagem. | Se houver tempo para endurecer a confiabilidade de submissão. |

# **31\. Checklist de conformidade com o enunciado**

| Requisito do trabalho | Como será atendido | Obrigatório/Bônus | Componente responsável |
| :---- | :---- | :---- | :---- |
| 3+ serviços independentes | Submission API, Execution Worker e Result Service. | Obrigatório | Arquitetura geral |
| Containers por serviço | Cada serviço possui Dockerfile/container próprio. | Obrigatório | Todos |
| Comunicação síncrona | REST entre cliente/API, API/Result e Worker/Result. | Obrigatório | Submission API / Result Service / Worker |
| Comunicação assíncrona | RabbitMQ para fila de Jobs. | Obrigatório | Submission API / Worker |
| 2+ réplicas \+ balanceador | 2 Submission APIs atrás de Nginx. | Obrigatório | Nginx \+ Submission API |
| Pool de Workers | 2+ Workers concorrentes. | Obrigatório para a demo do tema | Worker |
| Consumidores idempotentes | Claim/finalização condicional por Job ID e lease. | Obrigatório | Worker \+ Result Service |
| Timeout e retry com backoff | HTTP/AMQP com timeout e retry de falhas transitórias. | Obrigatório | Todos os chamadores remotos |
| /health | Endpoint nos três serviços. | Obrigatório | Todos os serviços |
| Logs estruturados | JSON com Correlation-ID, Job ID e Worker ID. | Obrigatório | Todos |
| Correlation-ID | Header REST e metadata da mensagem. | Obrigatório | Todos |
| Falha ao vivo | Matar Worker e provar recuperação sem perda/duplicação final. | Obrigatório | Worker \+ Result Service \+ RabbitMQ |
| Teste de carga | k6/Locust com vazão e p95. | Obrigatório | tests/load |
| Python \+ C\# | sandbox-python e sandbox-dotnet. | Obrigatório Tema 3 | Worker/Sandbox |
| Limite de CPU | Quota no container efêmero. | Obrigatório Tema 3 | Sandbox |
| Limite de memória | Memory limit do container. | Obrigatório Tema 3 | Sandbox |
| Limite de processos | PIDs limit. | Obrigatório Tema 3 | Sandbox |
| Tempo máximo | Timeout externo controlado pelo Worker. | Obrigatório Tema 3 | Worker/Sandbox |
| Rede desativada | Sandbox sem rede externa. | Obrigatório Tema 3 | Sandbox |
| Filesystem read-only | Root FS somente leitura; /tmp ou /workspace temporário gravável. | Obrigatório Tema 3 | Sandbox |
| Lease \+ heartbeat | Claim com lease\_until e renovação periódica. | Obrigatório Tema 3 | Worker \+ Result Service |
| Reatribuição de Job | Lease expirado permite nova tentativa por outro Worker. | Obrigatório Tema 3 | Result Service \+ RabbitMQ |
| 1 resultado final | Finalização condicional; tentativa antiga não sobrescreve. | Obrigatório Tema 3 | Result Service |
| Terraform apply/destroy | Provisiona e remove ambiente Azure. | Obrigatório Tema 3 | infra/terraform |
| API sem Docker socket | Somente Worker controla daemon; API não recebe socket. | Obrigatório/alerta do tema | Submission API |
| Sandbox sem privilégios | Container do código roda não-root e não privileged. | Obrigatório/alerta do tema | Sandbox |
| Docker Compose local | Todo ambiente sobe em um comando. | Obrigatório | docker-compose.yml |
| C4 níveis 1 e 2 | Contexto e Containers. | Obrigatório | docs/diagrams |
| Diagrama de sequência | Fluxo principal e falha/recuperação. | Obrigatório | docs/diagrams |
| 3–5 ADRs | Cinco ADRs propostos. | Obrigatório | docs/adr |
| README \+ roteiro de falha | Execução, arquitetura, IA declarada e passos da demo. | Obrigatório | README |
| KEDA | Opcional; não entra no MVP. | Bônus | Futuro |
| gVisor/Firecracker | Opcional; não entra no MVP. | Bônus | Futuro |

# **32\. Revisão final de complexidade**

Antes de considerar esta arquitetura fechada, foram revisadas as decisões que poderiam aumentar o esforço sem melhorar a nota proporcionalmente.

| Possível complexidade | Decisão simplificada | Motivo |
| :---- | :---- | :---- |
| AKS desde o início | VM Azure \+ Docker Compose | Mantém Terraform/Azure e remove curva de Kubernetes do caminho crítico. |
| Azure Service Bus \+ RabbitMQ local | RabbitMQ nos dois ambientes | Evita duas implementações de mensageria. |
| Banco por microsserviço | Um PostgreSQL pertencente ao Result Service | Não há necessidade de múltiplos domínios persistentes. |
| Serviço separado de scheduler/reaper | Rotina interna no Result Service | Mesma responsabilidade de estado/lease, menos um deploy. |
| Exactly-once execution | At-least-once \+ idempotência | É a abordagem realista e suficiente para a exigência de um único resultado final. |
| Suporte C\# completo | Template Console simples | Cumpre duas linguagens sem resolver build de projetos arbitrários. |
| Grafana/Jaeger obrigatório | Logs JSON primeiro | Observabilidade mínima atende o núcleo; tracing pode ser bônus. |

| Arquitetura recomendada para começar: Nginx \+ 2 Submission APIs \+ RabbitMQ \+ 2 Workers \+ Result Service \+ PostgreSQL, tudo em Docker Compose; cada Job roda em sandbox efêmero Python ou .NET. Na Azure, provisionar uma VM Linux com Terraform e executar a mesma composição. Não adicionar AKS até o fluxo de falha, idempotência e sandbox estarem completos. |
| :---- |

