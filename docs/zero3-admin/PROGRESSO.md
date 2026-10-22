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

**Próximo passo:** aguardar o comando explícito para iniciar somente a Tarefa 4/6.
