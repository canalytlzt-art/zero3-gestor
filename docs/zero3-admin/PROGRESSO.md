# ZERO3 PRO — progresso da atualização

## Tarefa 1/6 — Auditoria da base existente

**Status:** concluída como diagnóstico. Nesta etapa não houve alteração de código, esquema ou dados.

### Base encontrada

- **Stack:** pnpm workspace com React, Vite, TypeScript, Wouter e TanStack Query no app; Express no servidor; Drizzle ORM e PostgreSQL na persistência; contratos OpenAPI com tipos e validações gerados.
- **Execução:** workflows existentes `artifacts/zero3-pro-vendas: web` e `artifacts/api-server: API Server`. Os comandos de desenvolvimento são `pnpm --filter @workspace/zero3-pro-vendas run dev` e `pnpm --filter @workspace/api-server run dev`.
- **Autenticação:** Clerk gerenciado. A interface exige sessão e o servidor protege as rotas; além da sessão, o servidor exige e-mail primário verificado na allowlist `ZERO3_ALLOWED_EMAILS`. Uma requisição sem sessão ao endpoint de restauração retornou HTTP 401 em verificação anterior.
- **Abas:** a aplicação já tem Lançamentos e Scoreboard. A prévia aberta durante a verificação mostrou somente a página pública porque não havia sessão autenticada no navegador de validação.
- **Persistência de desenvolvimento:** PostgreSQL via `DATABASE_URL`. A consulta agregada ao banco de desenvolvimento encontrou **0 vendas e 0 metas**; a listagem de tabelas mostrou somente `sales` e `sales_goals`. Nenhum conteúdo de registro foi consultado ou exibido.
- **Produção:** a ferramenta de banco informou que este projeto não possui banco de produção Replit. Não inspecionei outro banco externo nem acessei dados de produção.
- **Recuperação:** não foi criado dump manual nesta auditoria, pois o banco de desenvolvimento consultado está vazio e nenhuma alteração de esquema foi feita. Antes de uma migração, confirmar/criar checkpoint do código e cópia privada do banco efetivamente usado; nunca guardar dump em diretório público ou no Git. A existência e o alvo de eventual banco externo de produção ainda precisam ser confirmados antes de qualquer operação nele.

### Funcionalidades persistentes encontradas

| Área | Estado atual |
| --- | --- |
| Vendas | Cadastro, leitura, edição e exclusão física via API e PostgreSQL. O servidor valida data, quantidade e centavos e recalcula o total. IDs são UUIDs. |
| Produtos | Não há entidade/catálogo separado nem ID de produto. Sugestões e filtros são derivados dos nomes nas vendas. A criação normalizada usa bloqueio transacional, mas renomeação, preço sugerido e inativação de produto não existem. |
| Histórico | Lista de vendas com filtros de data/produto e edição. A exclusão remove a linha; não há cancelamento com motivo, histórico de alterações, versão otimista ou idempotência persistente. |
| Scoreboard | Calculada no cliente a partir da lista de vendas carregada. Há filtros por mês atual, mês, múltiplos meses, intervalo e todos os meses; totais por produto/mês conciliam para vendas sem estornos. Não há paginação do histórico no servidor nem agregação financeira compartilhada na API. |
| Metas | Persistidas em `sales_goals`, com unicidade por mês/escopo; comparação atual é com vendas brutas. |
| Importação | Não foi encontrada importação CSV/XLSX. O seletor de arquivo existente é para restaurar backup JSON. |
| Excel e backup | Há exportação `.xlsx` de vendas e backup JSON mensal de vendas/metas. Ainda não incluem estornos, dependências, vínculos ou conflitos de registros diferentes com o mesmo ID, conforme a especificação atualizada. |
| Estornos | Não há tabela, rotas ou interface de estornos. |

## Tarefa 2/6 — Dados persistentes e validações

**Status:** concluída no banco de desenvolvimento. Nenhuma alteração foi aplicada a um banco de produção.

### Alterações

- `drizzle-kit push` aplicou alterações aditivas no PostgreSQL de desenvolvimento. Antes da migração, uma nova consulta confirmou 0 vendas, soma de quantidades 0, faturamento de 0 centavos e 0 metas. O backfill terminou com 0 vendas e 0 metas de plano vinculadas; os totais antes/depois foram comparados e permaneceram iguais.
- Produtos agora têm UUID estável e nome normalizado (espaços aparados/condensados e comparação sem diferenciar caixa). Vendas guardam o `productId` e preservam o nome/preço como snapshot. Metas de plano também usam vínculo estável; metas gerais continuam sem produto.
- Vendas têm status ativo/cancelado, versão otimista, timestamps e autor interno. A rota de exclusão preserva o registro como cancelamento; alterações e eventos de produto, venda, meta e restauração geram histórico com ator.
- Foram adicionadas estruturas persistentes para estornos, lotes de importação e chaves de idempotência. Criação de venda, edição e gravação de meta usam idempotência transacional; edição exige a versão carregada. A função de estorno bloqueia a venda e calcula o saldo restante para uso pelo fluxo da Tarefa 4.
- Validações de data civil, quantidade, centavos e total calculado foram centralizadas no servidor. O total é calculado com `BigInt`; o banco também restringe valores, vínculos, estados e a igualdade quantidade × valor unitário. A data padrão do formulário usa `America/Sao_Paulo`.
- A lista de produtos tem rota protegida. As rotas de vendas, metas, produtos e restauração continuam exigindo autenticação e allowlist no servidor.
- Foi criado um backfill repetível e protegido contra execução em `NODE_ENV=production`, além de um verificador do esquema que insere dados fictícios em transação e faz rollback.

### Verificações e limites

- `pnpm run typecheck` passou. O build do app `zero3-pro-vendas` passou com `PORT=5173` e `BASE_PATH=/zero3-pro-vendas`. O build agregado não concluiu: a primeira execução parou no `mockup-sandbox` porque `PORT` não estava definido. Permanecem avisos de source map e tamanho do bundle.
- `pnpm --filter @workspace/db run verify-sales-schema` passou: centavos exatos, total calculado, quantidade positiva, data inválida, chave estrangeira, consistência do total, vínculo de meta, valor de estorno e unicidade da chave de idempotência. Os registros de teste foram revertidos.
- Depois do reinício dos workflows, o banco continuou com 0 registros e todas as tabelas novas presentes. Requisições sem sessão a vendas, produtos e metas retornaram HTTP 401.
- Não há banco de teste dedicado configurado; a verificação usou transação com rollback no banco de desenvolvimento. Não foi possível testar gravações autenticadas no navegador de validação, que permanece deslogado.
- A exportação/backup atual ainda é a versão anterior focada em vendas ativas e metas. A preservação de estornos, cancelamentos, vínculos e conflitos de restauração continua na Tarefa 6.

### Plano para as tarefas 3 a 6

1. **Tarefa 3 — Vendas e produtos:** atualizar `artifacts/zero3-pro-vendas/src/components/sales-management.tsx` e as rotas para edição concorrente, cancelamento com motivo, histórico e importação CSV/XLSX com prévia e reenvio idempotente.
2. **Tarefa 4 — Estornos:** criar fluxo vinculado à venda, com validação atômica do saldo, datas, idempotência, anulação/correção auditável e bloqueios de edição incompatível.
3. **Tarefa 5 — Scoreboard e design:** centralizar o cálculo financeiro no servidor e apresentar vendas, estornos, resultado após estornos e quantidade; alinhar filtros, metas e interface.
4. **Tarefa 6 — Relatórios, backup e aceite:** produzir Excel conciliado; expandir o JSON mensal com IDs, vínculos e dependências; validar restauração idempotente e os cenários em banco isolado com dados fictícios.

### Pendências

- A pasta `tarefas/` não estava extraída no projeto; as instruções foram lidas diretamente do ZIP anexado.
- A interface autenticada, gravação real por usuário autorizado e concorrência entre requisições ainda precisam ser validadas nas próximas etapas.

## Tarefa 3/6 — Vendas, produtos e histórico

**Status:** concluída em desenvolvimento. Nenhum dado fictício foi gravado e não houve migração adicional nesta etapa.

### Alterações

- O catálogo persistente permite cadastrar, renomear, editar preço sugerido e ativar/desativar produtos. As vendas mantêm o nome salvo no momento da venda; mudanças no catálogo não reescrevem snapshots históricos.
- Os lançamentos usam produtos ativos, preenchem o preço sugerido quando selecionados e mantêm criação/edição com centavos, idempotência e versão otimista.
- O histórico mostra vendas ativas e canceladas com filtros de data, produto e situação. Cancelar exige motivo, confirmação, versão esperada e chave idempotente; o registro é preservado, e a tela de detalhe consulta sua trilha de auditoria.
- Importação CSV/XLSX oferece associação de colunas, validação por linha e confirmação explícita. Linhas coincidentes com vendas existentes são marcadas como possíveis duplicidades, sem remoção automática. O mesmo arquivo usa hash SHA-256 e reenvio idempotente.
- Rotas de produtos, cancelamento, importação e leitura de histórico seguem protegidas por sessão e allowlist.

### Verificações e limites

- `pnpm run typecheck` passou, incluindo bibliotecas, API e app.
- `PORT=5173 BASE_PATH=/zero3-pro-vendas pnpm --filter @workspace/zero3-pro-vendas run build` passou. Permanecem avisos de source map em componentes existentes e de tamanho do bundle.
- Os workflows de API e app reiniciaram sem erros de inicialização. Chamadas sem sessão a `/api/products`, `/api/sales/history` e `/api/sales/import` retornaram HTTP 401, como esperado.
- A captura visual abriu a página pública de login, não a área autenticada. Não foi possível validar os fluxos de gravação no navegador nem importar dados reais/fictícios nesta etapa.
- Não foi alterado banco de produção nem feita nova migração.

**Próximo passo registrado à época:** iniciar somente a Tarefa 4/6 após autorização explícita.

## Tarefa 5/6 — Scoreboard e conciliação

**Status:** concluída em desenvolvimento. A alteração não gravou dados de venda ou estorno permanentes.

### Alterações

- A rota protegida `/sales/scoreboard` recebe um mês, vários meses, intervalo inclusivo ou nenhum recorte temporal, além do filtro opcional por produto.
- O servidor agrega vendas ativas pela data da venda e estornos ativos pela data do estorno em consultas separadas, e só então combina os valores por produto e mês. Isso evita multiplicar uma venda que tenha vários estornos.
- A resposta usa centavos inteiros, quantidade somada das vendas e IDs estáveis de produto. Produtos com estornos no recorte aparecem mesmo sem venda naquelas datas; o saldo líquido pode ser negativo.
- Meses selecionados sem movimentação retornam linhas zeradas. A consulta sem período inclui os meses entre a primeira e a última movimentação (incluindo o mês atual).
- A Scoreboard mostra vendas, estornos, saldo após estornos e quantidade, com totais por produto e mês. O filtro usa o catálogo persistente; “Atualizar” refaz a leitura e reabrir a aba força nova consulta.
- O valor realizado das metas existentes passou a usar o saldo após estornos; a regra de cobertura mensal não foi alterada nesta etapa.

### Verificações e limites

- `pnpm --filter @workspace/api-spec run codegen` passou.
- `pnpm --filter @workspace/api-server run typecheck` e `pnpm --filter @workspace/zero3-pro-vendas run typecheck` passaram.
- `pnpm --filter @workspace/db run verify-sales-schema` passou, incluindo cenários fictícios de outubro/novembro, produto com estorno no recorte sem venda na mesma data e conciliação de valores. Os casos foram executados em transação com rollback.
- A interface autenticada não foi confirmada no navegador deslogado; a captura disponível mostra apenas a entrada de autenticação. Não houve consulta nem alteração de banco de produção.

**Próximo passo:** concluir a interface e os testes do fluxo de estornos (Tarefa 4/6) antes de avançar para Excel e backup mensal (Tarefa 6/6).

## Excel, backup mensal e restauração — 22/10/2026

**Escopo autorizado:** “Iniciar Excel e backup mensal”. Implementação no app existente; sem publicação, migração ou acesso ao banco de produção.

### Entrega

- Menu **Exportar**, em Lançamentos: planilha real `.xlsx`, backup mensal JSON e restauração com prévia.
- Excel com duas abas, `Lançamentos` e `Resumo por plano`. O relatório financeiro usa vendas e estornos ativos, cada um na sua própria data, respeitando data e produto. Inclui IDs, vínculo e data da venda original, nome atual e snapshot comercial, quantidade somente nas vendas, valores numéricos em reais, motivo/observação e impacto líquido. O resumo traz filtros, quatro totais, resultados por produto e mês e total geral. Texto que começa com `=`, `+`, `-` ou `@` continua texto, nunca fórmula.
- Backup `schemaVersion: 2`, `period`, `generatedAt`, `currency: BRL`, `businessTimezone: America/Sao_Paulo` e contagens. O servidor lê um snapshot consistente, sem depender do filtro de produto nem do cache do navegador.
- São preservados produtos, vendas, estornos, metas mensais, status, versões, IDs, autores, datas e trilhas associadas. Inclui vendas de outros meses necessárias aos estornos e todos os estornos conhecidos das vendas incluídas. Cada envelope distingue `period` de `dependency`.
- A prévia consulta a base e separa novos, idênticos e conflitos; informa meses adicionais. IDs iguais com conteúdo idêntico são ignorados; conteúdos diferentes mantêm a versão atual. Metas conflitantes do mesmo mês/escopo também não são sobrescritas.
- A confirmação reanalisa os vínculos sob bloqueio transacional. Saldos excedidos e vínculos incompatíveis bloqueiam o lote. Inserções são atômicas; uma falha não deixa uma restauração parcial. Backups antigos V1 continuam aceitos sem inventar estornos ou histórico ausentes.
- Antes de aplicar, o servidor grava um snapshot privado de recuperação em `sales_history`, identificado por `entityType=restore-snapshot` e `operation=pre-restore-backup`, com os registros afetados atuais e IDs previstos para inserção. Esse material não aparece nos backups públicos de movimentações.
- Mês vazio é informado como vazio; nenhum registro de venda é criado. Arquivos inconsistentes ou acima de 10 MB não são gerados para evitar entregar uma cópia que o app não consiga restaurar.

### Como usar e iniciar

1. Os workflows gerenciados são `artifacts/api-server: API Server` (`pnpm --filter @workspace/api-server run dev`) e `artifacts/zero3-pro-vendas: web` (`pnpm --filter @workspace/zero3-pro-vendas run dev`).
2. Entre com uma conta autorizada e abra **Lançamentos → Exportar**. **Planilha do período** usa os filtros de data e produto do histórico; registros cancelados/anulados não compõem o resultado financeiro.
3. Em **Backup mensal**, escolha mês/ano e gere o JSON. A cópia inclui todo o mês, independentemente do produto filtrado, mais as dependências indicadas.
4. Em **Restaurar backup**, selecione o JSON, confira contagens, meses adicionais e conflitos. Só **Confirmar restauração** grava. Cancelar a prévia não altera a base.
5. A cópia privada anterior é um recurso técnico de recuperação, não uma opção de download. Não existe reversão automática nesta versão: eventual recuperação deve considerar o snapshot e os IDs inseridos, preservando alterações posteriores. O comportamento normal já mantém registros existentes em caso de conflito, sem sobrescrevê-los.

### Evidências executadas

- `pnpm --filter @workspace/api-spec run codegen`: passou.
- `pnpm run typecheck`: passou para bibliotecas, API, app e sandbox.
- `pnpm --filter @workspace/api-server run verify-sales-backup`: passou em desenvolvimento, usando **tabelas temporárias privadas à transação e rollback**. Nenhuma venda fictícia foi inserida em tabelas compartilhadas; quantidade e soma das vendas reais foram conferidas antes/depois.
- Fixture outubro/novembro: o XLSX reaberto tem dinheiro numérico, nomes/observações como texto, estorno de venda antiga na data correta, novembro líquido **R$ 380,00**, quantidade **6**, e produto com saldo **−R$ 440,00**. Mês vazio permanece zerado.
- O backup de novembro contém a venda original de outubro, dependência de estorno anulado e histórico. Restaurar em tabelas vazias reproduziu **R$ 380,00**; repetir inseriu zero registros financeiros. Duas vendas legítimas com mesmos campos e IDs diferentes foram ambas restauradas. Conteúdo antigo não sobrescreveu venda mais nova. Total inválido, saldo combinado excedido e falha SQL foram tratados sem inserção parcial.
- `PORT=5173 BASE_PATH=/zero3-pro-vendas pnpm --filter @workspace/zero3-pro-vendas run build`: passou. Persistem avisos de source map e tamanho do bundle já existentes.
- Workflows de API e app reiniciados e servindo. As três novas/leitura-restauração protegidas (`GET /api/sales/backup`, `POST /api/sales/restore/preview`, `POST /api/sales/restore`) retornaram **401** sem sessão.
- Navegador autenticado em 1440 px: download JSON de janeiro/2035 vazio com metadados corretos, upload e prévia carregada pelo servidor com confirmação disponível, rejeição de JSON malformado com confirmação desabilitada e download XLSX real com filtros de janeiro/2035. A confirmação de restauração não foi acionada; nenhum dado real foi alterado pelo teste.
- Navegador em 390 px: página sem transbordamento horizontal; diálogo de backup com rolagem e botões alcançáveis por Tab. O teste identificou o menu Exportar cortado à esquerda; corrigido alinhamento para a esquerda no celular e mantido alinhamento à direita no desktop, com largura limitada à janela. Essa correção simples foi conferida no código, sem repetir a sessão completa do navegador.

### Não executado / limites

- Nenhuma publicação, consulta ao banco de produção, restauração na produção ou alteração de dados financeiros reais.
- Reversão automática do snapshot privado e agendamento automático de backups não fazem parte desta versão.
- Teste simultâneo de duas requisições HTTP autenticadas de restauração não foi executado. A reanálise sob bloqueio de tabelas e a transação protegem a gravação concorrente; a idempotência sequencial foi executada.
- A gravação pelo botão final de restauração no navegador não foi executada para preservar os dados compartilhados. O mesmo procedimento transacional foi executado pelo verificador em tabelas temporárias, incluindo falha SQL com rollback.

## Nome no registro de venda — 22/10/2026

- **Nome** é opcional e permite identificar o cliente ou registrar outra informação curta sobre quem comprou. O campo tem limite de 120 caracteres; espaços externos e repetições são normalizados.
- O valor é salvo na base compartilhada, reaparece ao editar e fica visível no histórico. Também é mantido em importações, planilhas Excel e backups mensais; backups antigos sem esse campo continuam válidos e restauram o nome como vazio.
- A coluna `customer_name` foi adicionada como texto anulável somente ao banco de desenvolvimento. Nenhuma migração ou alteração foi aplicada ao banco de produção.
- `pnpm --filter @workspace/api-spec run codegen`, `pnpm run typecheck`, `pnpm --filter @workspace/db run verify-sales-schema`, `pnpm --filter @workspace/api-server run verify-sales-backup` e o build do app passaram.
- Os testes de banco e restauração usaram dados fictícios, tabelas temporárias e rollback. A interface após autenticação não foi validada neste navegador.

## Correção da importação de planilhas — 22/10/2026

### Diagnóstico

- O leitor anterior usava somente a primeira aba, considerava a primeira linha como cabeçalho e exigia produto, quantidade e valor unitário. Uma origem com apenas cliente, Data de início e valor total era rejeitada pelo próprio contrato e mapeamento.
- Nos testes de correção, CSV UTF-8 lido diretamente como bytes corrompia cabeçalhos acentuados. O CSV agora é decodificado explicitamente como texto, com alternativa Windows-1252 quando necessário.
- Nenhum arquivo original XLSX/CSV estava disponível nos anexos ou no ZIP; os testes abaixo usam fixtures isoladas. Não é possível afirmar que a planilha real foi reproduzida.

### Entrega

- Importação de XLSX e CSV com três campos obrigatórios: nome do cliente, Data de início/data da venda e valor total. Produto/categoria é opcional. Cada linha importada representa uma venda de quantidade 1 e valor unitário igual ao total informado.
- Todas as abas são lidas, com seleção individual, identificação de abas ocultas, cabeçalho após títulos/linhas vazias, mapeamento por aba e exemplos. Abas ocultas e abas sem mapeamento completo começam desmarcadas, sem impedir o uso das outras.
- Datas brasileiras, ISO e seriais dos sistemas Excel 1900/1904 são convertidas em dias sem deslocamento de fuso. A API também verifica o texto original da data antes da coerção do validador gerado.
- Valores brasileiros e células numéricas são convertidos para centavos inteiros. Valor vazio, negativo, inválido ou sem precisão de centavos não vira zero. O total da prévia é acumulado com precisão inteira.
- A prévia mostra aba, linha física, cliente, data, produto, valor e status, inclusive os valores originais das linhas inválidas. Linhas selecionadas com erro bloqueiam a confirmação até corrigir o mapeamento ou desmarcá-las. Linhas vazias e totais/subtotais são contados e ignorados.
- O hash original mantém a proteção contra reenvio do mesmo arquivo. Duas vendas legítimas com os mesmos campos, mas em linhas distintas, permanecem separadas. Arquivo, aba, linha e lote ficam na trilha de importação.
- Sem categoria, a venda tem vínculo de produto nulo e aparece como **Não categorizado**, sem criar item fictício no catálogo. Editar outros campos preserva essa condição; escolher um produto permite a classificação posterior.
- Scoreboard, relatório Excel e backup/restauração V2 aceitam e incluem vendas não categorizadas. A importação invalida as consultas de vendas e Scoreboard.
- A única alteração de esquema nesta correção foi permitir `product_id` nulo no banco de desenvolvimento. Registros existentes foram preservados; produção não foi consultada, migrada nem publicada.

### Verificações

- Geração dos contratos, typecheck da API e do app e build com `PORT=19851 BASE_PATH=/`: passaram. O build mantém os avisos já existentes de source map e tamanho do bundle.
- Testes do leitor: múltiplas abas, aba oculta, preâmbulo, cabeçalho na linha 3, preferência por Data de início, nomes acentuados, CSV com aspas, ausência de cabeçalho sem perder a primeira venda, valores brasileiros/numéricos, datas Excel e rejeição de datas/valores inválidos.
- Integração HTTP em esquema PostgreSQL isolado: importação só com os três campos, duas vendas legítimas idênticas preservadas, reenvio sem duplicação, ausência de produto fictício, nome e origem preservados, conciliação na Scoreboard, edição de cliente sem criar produto e rejeição de data/valor inválidos.
- Verificador de Excel/backup: venda não categorizada validada pelo servidor e cliente, incluída no XLSX e restaurada sem produto fictício. As tabelas privadas e o rollback mantiveram inalteradas a quantidade e a soma das vendas compartilhadas.
- Limites mantidos e informados na interface: XLSX/CSV, 10 MB por arquivo e 500 linhas selecionadas por importação. A proteção por hash é do arquivo inteiro; importar abas adicionais desse mesmo arquivo em outro momento não é um fluxo separado nesta versão.
- Navegador autenticado: prévia do CSV com cabeçalho na linha 3, total da linha 6 ignorado, cliente/data/valor corretos e produto opcional. Linha inválida manteve seus valores originais e bloqueou confirmação; desmarcá-la, remapear data e selecionar/desmarcar aba atualizaram a disponibilidade corretamente. Em 390 px, botões alcançáveis por rolagem e nenhuma largura extra na página. Nenhuma confirmação foi acionada nem requisição de importação enviada.
- Após a inspeção visual, ajustado o resumo para mostrar a quantidade selecionada explicitamente e não contar uma linha inválida ainda selecionada como se já estivesse excluída. Essa correção de contagem foi conferida no código e pelo typecheck, sem repetir a sessão do navegador.

## Conferência da planilha original e reprocessamento parcial — 22/10/2026

### Arquivo original examinado

A planilha de clientes individuais foi localizada e lida diretamente: seis abas, cada uma com intervalo utilizado até a linha 1000 e dez colunas. Todas as 6000 linhas físicas foram contabilizadas; 140 têm conteúdo, incluindo seis cabeçalhos. Não se presumiu que as 134 linhas posteriores aos cabeçalhos fossem vendas.

| Aba | Vendas completas | Pendentes | Auxiliares | Linhas auxiliares | Linhas vazias/formatação |
| --- | ---: | ---: | ---: | --- | --- |
| JANEIRO | 23 | 1 | 0 | — | 26–1000 |
| Fevereiro | 9 | 0 | 15 | 11–25 | 26–1000 |
| Março | 25 | 0 | 6 | 27–32 | 33–1000 |
| Abril | 2 | 0 | 22 | 4–25 | 26–1000 |
| Maio | 11 | 0 | 13 | 13–25 | 26–1000 |
| junho | 7 | 0 | 0 | — | 9–1000 |
| **Total** | **77** | **1** | **56** | | **5860 linhas** |

- **78 candidatos = 77 prontos + 1 pendente + 0 já importados na base isolada.** As 56 linhas auxiliares e os seis cabeçalhos são contados à parte. A prévia compartilhada também consulta as origens já presentes na base real de desenvolvimento e ajusta prontos/já importados sem gravar nada.
- Soma das 77 vendas completas: **R$ 54.448,00**, conferida independentemente nas células B/F/H da origem e conciliada com a Scoreboard após gravação isolada.
- **Março · 29 e Março · 30:** somente D/E (Modalidade/Recorrência) têm conteúdo. B/F/H e as demais colunas não contêm cliente, data ou valor; não foi perda de extração. São linhas auxiliares pré-preenchidas, não vendas.
- **Pendência real: JANEIRO · 7.** B7 (NOME) não existe/preenche nome; F7 contém o serial 46027 (**05/01/2026**), H7 contém **R$ 1.197,00**. O conteúdo de C7 não foi assumido como nome. Essa linha fica pendente apenas pelo cliente, preservando data e valor, e não entra no total importável.
- Mapeamento reconhecido automaticamente em todas as abas: B/NOME, F/INICIO, H/VALOR. INICIO tem prioridade sobre A/DATA e G/FIM. O serial **46150 → 08/05/2026** foi testado explicitamente.

### Correções restritas ao importador

- Extração direta das células com tipo, resultado calculado, formato, fórmula, endereço original, linhas/colunas ocultas e filtro salvo. Nenhuma compactação das posições vazias. Filtros e linhas ocultas não removem conteúdo silenciosamente.
- Cabeçalhos repetidos são auxiliares; blocos com cabeçalhos/posições diferentes têm mapeamento próprio. Uma única data identificável por texto/tipo/formato pode ser usada como recurso final; números comuns não são inferidos como datas. Ambiguidades exigem confirmação da coluna por bloco.
- Campos reconhecidos são preservados independentemente. Fórmulas sem cache não viram zero: o marcador SheetJS `t:"z", v:0` é tratado como ausência de resultado. Fórmulas com cache válido continuam aceitas.
- Somente prontos são selecionados automaticamente. Pendentes, auxiliares e já importados ficam desmarcados. A confirmação dos prontos não é bloqueada por pendências separadas. É possível filtrar pendentes e consultar todas as células originais, além das linhas auxiliares/cabeçalhos/totais.
- O servidor consulta origem persistente (hash original + aba + linha), incluindo histórico legado ligado ao lote. Sob bloqueio transacional por arquivo, grava apenas origens novas. O lote anterior não bloqueia abas/linhas restantes; não há comparação por nome e valor.
- Depois de gravar, a prévia marca as origens como já importadas e mantém pendências consultáveis. Lançamentos e Scoreboard são relidos.
- Nenhuma migração ou alteração de esquema foi necessária. Arquivo original, edição manual, dados compartilhados, autenticação e demais funcionalidades foram preservados.

### Verificações executadas

- Geração dos contratos, typecheck da API/app e build passaram; permanecem os avisos preexistentes de sourcemap e tamanho do bundle.
- Testes do leitor com a origem real: seis abas, contagem de todas as linhas, inspeção direta de Março 29/30, 77 vendas, 56 auxiliares, uma pendência e soma de centavos independente. Testes sintéticos cobrem blocos reposicionados, cabeçalhos repetidos, datas 1900/1904, serial 46150, texto brasileiro/ISO, números não datados, datas ambíguas, cache de fórmulas e linhas ocultas.
- Integração em esquema PostgreSQL isolado: primeiro 38 vendas da origem, depois dois envios simultâneos das 77. Um inseriu somente as 39 restantes, o outro zero; as 38 anteriores mantiveram seus IDs. Consulta persistente identificou as 77 origens, o lote totalizou 77 e a Scoreboard conciliou **77 / R$ 54.448,00**. Histórico legado sem hash direto também foi reconhecido pelo lote.
- Regressões de edição sem categoria, metas, estornos e verificador de Excel/backup passaram. Os testes usaram esquema isolado ou tabelas temporárias com rollback, sem gravar essas vendas nas tabelas compartilhadas.
- Permanecem os limites de 10 MB e 500 linhas selecionadas por envio. A identidade é do arquivo original: versões com bytes alterados são outra origem e não são mescladas automaticamente por semelhança.
- Nenhuma publicação nem consulta, migração ou gravação em produção.
- Navegador autenticado com o arquivo original: confirmou seis abas selecionadas, 78 candidatos (77 prontos, uma pendência, zero origens anteriores), 56 auxiliares, 5860 vazias e total selecionado **R$ 54.448,00**. Confirmar permaneceu disponível com a pendência fora da seleção; a lista de pendentes preservou data/valor e apresentou somente falta do cliente em JANEIRO 7.
- A conferência visual também validou INICIO e exemplos convertidos nas seis abas, fonte F2/F7, auxiliares Março 29/30, seleção por aba e linha recalculando quantidade/valor. Em 390 px, rodapé alcançável e nenhum transbordamento horizontal da página; a tabela mantém rolagem interna. Não houve erros de aplicação. O diálogo foi cancelado, sem clicar Confirmar nem enviar POST de importação.

## Ocupação manual — etapa 2 de 6

- Acrescentada `/ocupacao` protegida pelo mesmo controle de acesso, com navegação desktop/celular para Lançamentos, Scoreboard e Ocupação. Gráficos e importação de ocupação permanecem nas etapas posteriores, sem botões fictícios.
- Modalidades têm IDs internos estáveis, criação por nome no formulário ou janela própria e renomeação com controle de versão. Espaços e diferenças de caixa não criam duplicatas; nomes diferentes continuam separados.
- Registros diários guardam uma data; mensais guardam a competência e data nula, sem expansão artificial em dias. Percentuais numéricos decimais de 0 a 100, turma/horário e observação opcionais. A interface aceita vírgula e não transforma vazio em zero nem ajusta valores fora da faixa.
- Histórico filtrável por dia, intervalo, um/vários meses, modalidade, tipo e turma. Meses e intervalo são exclusivos. Em intervalo parcial, consolidados mensais não são tratados como resultados daquele trecho; só entram no histórico filtrado quando o mês completo está contido.
- Edição carrega todos os campos e permite limpar opcionais. Exclusão tem confirmação; o registro sai da consulta ativa, preservando auditoria. Conflitos de versão ou do mesmo escopo retornam 409, sem somar ou sobrescrever percentuais silenciosamente. Índice único no banco protege envios simultâneos.
- Persistência aditiva em `occupancy_modalities`, `occupancy_records`, `occupancy_history`; nenhuma alteração em tabelas financeiras. Modelos Drizzle, SQL aditivo idempotente em `lib/db/scripts/occupancy-schema.sql` e execução de desenvolvimento por `node lib/db/scripts/add-occupancy.mjs`.
- Contratos acrescentados em OpenAPI e clientes/validadores regenerados. API separada em `routes/occupancy.ts`, sem refatorar as consultas financeiras existentes.
- Verificação concluída antes do navegador: typechecks API/app, build e 13 testes isolados passaram (quatro de ocupação; regressões do leitor original e das rotas de vendas, metas e estornos). Cobertura de ocupação: acesso, 0/100/decimais, calendário real, filtros inclusivos/múltiplos meses, escopos, renomeação/vínculos, opcionais nulos, conflitos de edição/exclusão, auditoria e duplicidade concorrente.
- A verificação de navegador usa a API real em esquema PostgreSQL privado através de `scripts/serve-occupancy-isolated.ts`; chamadas de ocupação são redirecionadas somente no navegador de teste. Não há alteração de autenticação ou roteamento na aplicação real.

## Importação de ocupação — etapa 3 de 6

- Incluído **Importar ocupação** dentro de Ocupação, com leitura local de XLSX/CSV, seleção de abas, prévia com célula de origem, modalidade, período, tipo, percentual e situação. O arquivo não é enviado nem guardado no navegador.
- O leitor reconhece linhas por dia/mês e as duas matrizes (modalidades×meses e datas×modalidades). Trata cabeçalhos repetidos, totais, células vazias, abas ocultas, datas civis/seriais Excel 1900/1904, CSV legado CP1252 e fórmulas com/sem resultado em cache.
- Valores com formato percentual e textos com `%` são convertidos explicitamente. Números gerais entre 0 e 1 exigem confirmação da escala; números maiores no mesmo bloco identificam a escala 0–100. Competências sem ano ficam pendentes até o operador informar um ano; nenhum ano atual é presumido.
- Linhas com cabeçalho não reconhecido, fórmula sem resultado/erro, percentual inválido ou ano/escala ambíguos permanecem pendentes e não chegam à gravação. Prévia e gravação mostram origem e contagens; importações em lotes de até 250 registros.
- A origem persistida é identificada por hash do arquivo, aba e célula do percentual. Reenvio não duplica; conflito de escopo pede revisão; atualização de conflito exige consentimento explícito por linha e versão atual. Escritas concorrentes não somam percentuais. Alterações geram histórico.
- A prévia não cria modalidades nem registros. A gravação usa somente as tabelas de ocupação. Migração aditiva aplicada somente no banco de desenvolvimento; `occupancy_records` ficou com as colunas de origem e 0 registros após a migração. Nenhuma tabela financeira foi alterada, nenhum dado de teste foi inserido na base compartilhada e produção não foi migrada/publicada.
- Não foram iniciados gráficos de ocupação nem financeiros desta etapa.

### Verificações

- 10 testes unitários do leitor passaram; cobrem os formatos, escala e ano explícitos, datas Excel 1900/1904, fórmulas, cabeçalhos/totais, abas e CSV.
- 6 testes de integração da ocupação passaram em esquema PostgreSQL privado; incluem prévia sem efeitos colaterais, idempotência, conflito e atualização versionada, histórico, repetição no lote e reenvio simultâneo.
- 4 testes de regressão de vendas/metas/estornos passaram. `typecheck:libs`, typecheck da API e do app passaram; build Vite passou, mantendo avisos já conhecidos de sourcemap e tamanho de bundle.
- Workflows da API e do app reiniciaram sem erros de compilação. A captura pública mostrou a página de entrada; a interface autenticada não foi conferida visualmente porque o navegador de validação não possui sessão. A funcionalidade protegida foi verificada por testes de integração isolados.
- Não foram implementadas importação de ocupação, consolidações, gráficos, vínculo financeiro de modalidades ou ampliação dos backups financeiros nesta etapa. Não houve publicação nem alteração em produção.
- Navegador desktop e 390×844: cadastro de diário 0%, mensal 75,125% e diário 100%, duplo clique sem duplicar, recarga, edição para 60,5% limpando opcionais, renomeação com edição aberta preservando o mesmo vínculo e novo salvamento a 80%, exclusão cancelada/confirmada, filtros de tipos/múltiplos meses/turma, intervalo parcial sem mensal, intervalo completo com mensal e mês vazio sem zero fictício passaram. Navegação financeira de leitura e “Ver detalhes” do histórico recolhido permaneceram corretos.
- A primeira configuração de interceptação do teste não cobriu um PATCH por ID: retornou 404 sem gravar, pois o UUID só existia na base privada. Corrigida a configuração do mesmo testador, sem alterar a aplicação; uma versão deliberadamente divergente retornou 409 no servidor privado antes de retomar somente os fluxos restantes. Foram confirmados zero registros/modalidades de teste na base compartilhada.

## Gráficos de ocupação — etapa 4 de 6

- Acrescentada a área protegida `/graficos` à navegação, com a opção Ocupação ativa. Faturamento aparece desabilitado e identificado como etapa 5/6; nenhum gráfico financeiro foi iniciado.
- Os filtros desta área são independentes dos filtros do histórico: dia, intervalo inclusivo ou meses escolhidos, modalidade e turma/horário. As consultas usam os registros persistidos da API; modalidades não são filtradas na consulta para preservar a comparação entre todas.
- Implementados gráfico de rosca de uma modalidade (ocupação e complemento até 100%), colunas de comparação de modalidades com escala fixa de 0 a 100% e evolução em colunas por dia ou mês. A tabela de apoio informa período, modalidade, turma/horário, percentual e se a origem é percentual informado ou média dos percentuais informados.
- Consolidação mensal respeita o consolidado informado por modalidade e turma/horário; sem ele, usa média aritmética simples dos diários. Intervalos parciais usam somente diários. Vários períodos usam média simples, com cobertura parcial explícita; lacunas permanecem nulas, nunca barras de 0%. Percentuais não são somados nem ponderados por capacidade.
- Atualização manual, busca ao abrir/retornar à janela, carregamento, erro e vazio estão cobertos. A página de gráficos é carregada sob demanda; nenhuma migração, rota ou gravação financeira foi adicionada.

### Verificações

- 6 testes de consolidação dos gráficos passaram, cobrindo comparação por modalidade, precedência mensal por escopo, intervalos parciais, média de períodos, cobertura incompleta e dias ausentes sem zero.
- 16 testes do importador e 7 testes das metas/utilitários financeiros passaram como regressões; typecheck do app passou.
- Build Vite passou. A página de gráficos ficou em chunk separado de 441 kB; o chunk de entrada mantém o aviso preexistente de tamanho. Permanecem os avisos de sourcemap das peças de tooltip/label.
- Workflow web reiniciado sem erros de inicialização. A captura do caminho `/graficos` sem sessão mostrou a página pública de entrada; a interface autenticada dos gráficos não pôde ser conferida visualmente pelo navegador de validação. A área preserva a autenticação existente.
- Nenhum dado de teste foi gravado na base compartilhada; não houve migração ou publicação em produção.
- Durante preenchimento nativo de datas ocorreram leituras transitórias 400 para entradas intermediárias; os intervalos finais retornaram 200 e resultados corretos. Sem transbordamento horizontal no celular; controles e janela de modalidades utilizáveis.
- A limpeza dos testes não depende apenas de sinal ao processo: após parar o servidor, `node lib/db/scripts/cleanup-occupancy-test.mjs` valida o nome e remove exclusivamente o esquema privado caso a finalização assíncrona não o tenha removido.

## Gráficos financeiros — etapa 5 de 6

- A área **Faturamento** em `/graficos` agora usa a mesma API agregadora da Scoreboard e aceita mês atual, mês específico, vários meses, intervalo inclusivo e histórico completo, além dos filtros de produto e modalidade.
- Incluídos gráficos de vendas brutas por modalidade e produto, evolução mensal de vendas/estornos/líquido, participação em rosca usando somente vendas positivas e quantidade de unidades por produto. Os agrupamentos e os meses são conferidos contra os totais oficiais; vendas sem vínculo permanecem como **Não classificado**.
- Produtos agora podem receber um vínculo opcional e explícito com uma modalidade na edição de Produtos. O nome do plano não é usado para inferir a modalidade. Alterar o vínculo reclassifica as vendas históricas nos gráficos, sem alterar datas, quantidades ou valores registrados.
- A Scoreboard passa a devolver o vínculo de modalidade por produto e aceita `modalityId` em seu filtro, preservando a agregação separada de vendas e estornos por data, inclusive valores líquidos negativos.
- Comparação de metas usa o líquido oficial apenas para escopos cadastrados (geral ou produto), sinaliza cobertura mensal parcial e não compara metas em intervalos parciais. Um filtro somente por modalidade não recebe meta inventada.

### Verificações

- 4 testes de agregação dos gráficos financeiros passaram; 6 testes de consolidação de ocupação e 7 testes de metas/utilitários passaram como regressão.
- Os 5 testes de integração da API de vendas passaram em esquema PostgreSQL isolado, incluindo modalidade explícita, filtro, vendas não classificadas e conciliação de venda/estorno/líquido. A consulta posterior confirmou zero registros de teste correspondentes na base compartilhada.
- Typecheck do monorepo e build Vite passaram. O chunk de gráficos ficou em 463 kB; permanecem os avisos preexistentes de sourcemap e tamanho do bundle principal.
- A coluna e o índice de modalidade foram aplicados somente ao banco de desenvolvimento; não houve alteração ou publicação em produção.
- Os workflows web e API reiniciaram sem erros. A captura de `/graficos` sem sessão mostrou a página pública de entrada; a interface autenticada dos gráficos não pôde ser conferida visualmente pelo navegador de validação. A autenticação existente foi mantida.

## Relatórios, backup e aceite — etapa 6 de 6

- Os endpoints HTTP de exportação e restauração de backup agora usam a conexão injetada pelo router, inclusive na prévia e nas restaurações V1/V2. A geração do backup lê os dados em uma transação repeatable-read.
- Foi acrescentado um teste HTTP isolado que confirma bloqueio para usuários anônimos e não autorizados, exportação a partir do esquema injetado, prévia sem inserções e repetição da restauração sem duplicar registros.
- O cenário fictício de outubro/novembro foi conferido pela API e pela planilha: vendas R$ 2.560,00; estornos R$ 960,00; líquido R$ 1.600,00; quantidade 12; produtos e meses conciliados. Também foram verificados filtro de produto em novembro (líquido -R$ 440,00), estorno no dia 15 sem venda no dia (líquido -R$ 660,00) e metas gerais com 61%, 38%, 53,33% e falta de R$ 1.400,00.
- O verificador gera e reabre um arquivo XLSX real, confirma abas, valores numéricos, textos literais e resumos. Também valida backup mensal com dependências, prévia, restauração em tabelas temporárias, reenvio idempotente, conflitos, payload inválido, rollback e mês vazio.

### Verificações

- `pnpm --filter @workspace/api-server run verify-sales-backup`: 11 verificações aprovadas usando tabelas temporárias em uma transação revertida; a contagem e a soma da tabela pública de vendas permaneceram iguais.
- `pnpm --filter @workspace/api-server run test:integration`: 7/7 testes passaram, incluindo autorização dos três endpoints de backup e uso do banco isolado.
- `pnpm -w run typecheck`: passou.
- Workflow da API recompilado e iniciado sem erros após a correção das rotas; nenhum schema de produção foi alterado.
- O build Vite e os testes de utilitários do frontend passaram na etapa anterior e não houve alteração de código do frontend nesta etapa.
- Limitação: a interface autenticada não foi visualmente validada porque o navegador de preview não possui sessão; nenhuma autenticação foi removida ou contornada. Não houve gravação de massa fictícia na base compartilhada nem publicação em produção.
