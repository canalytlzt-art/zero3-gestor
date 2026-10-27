# Matriz de testes Cloudflare

O registro item a item do checklist oficial está em [`ACEITE.md`](./ACEITE.md). Ele distingue evidência local/mock de validação Workers/Cloudflare e mantém “Não executado” explícito.

## Evidência registrada

Na validação anterior à T01: 33 testes do app passaram, assim como typecheck, build Vite e `wrangler deploy --dry-run`. Na T02, após as alterações abaixo, 36 testes do app, typecheck raiz, build e dry-run passaram. Essas evidências são locais; não comprovam login real, D1 remoto ou deploy integrado.

Nenhuma validação consultou ou alterou o D1 remoto.

## Resultados T02

- `pnpm --version` → `10.26.1`.
- `pnpm --filter @workspace/zero3-pro-vendas run test` → 36 testes aprovados, incluindo saúde/404 do Worker e sessões simuladas. Não são testes Clerk reais.
- `pnpm run typecheck` → aprovado após excluir `src/**/*.test.ts` do build composite de `api-client-react`; o teste Node continua no comando de testes do app. A primeira execução falhou por esses imports Node incluídos na biblioteca de navegador.
- `PORT=5173 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/zero3-pro-vendas run build` → aprovado; Vite transformou 2.584 módulos e escreveu `dist/public`. Permanecem avisos não bloqueantes de sourcemap e chunk acima de 500 KB.
- `pnpm --filter @workspace/scripts exec wrangler deploy --dry-run --config artifacts/zero3-pro-vendas/wrangler.jsonc --cwd ..` → aprovado com Wrangler 4.152.0, 8 arquivos de assets; dry-run não publicou.
- `pnpm --filter @workspace/scripts exec wrangler dev --local --persist-to /tmp/zero3-t02-worker --ip 127.0.0.1 --port 8787 --config artifacts/zero3-pro-vendas/wrangler.jsonc --cwd ..` → Wrangler confirmou `DB` e `ASSETS` em modo local. `GET /` e `/scoreboard` responderam 200 HTML; `/api/healthz` respondeu 200 JSON; `/api` e `/api/no-such-api` responderam 404 JSON.
- `curl http://localhost:80/api/t02-route-not-found` pelo proxy local do workspace → Express respondeu 404 JSON.
- Comparação estática de OpenAPI, Express e Worker → 39 operações, sem diferença de caminho/método. Ver [mapa de operações](./CONTRATOS_API.md#mapa-de-operações-t02).

O primeiro smoke Worker revelou que o wildcard `/api/*` não abrangia o caminho exato `/api`; a configuração foi corrigida para incluir ambos. O Worker local foi encerrado após os testes.

## Resultados T03 — Clerk e autorização

- `pnpm --filter @workspace/zero3-pro-vendas run test` → 46 testes aprovados; inclui JWT local (assinatura, expiração e emissor), origem/allowlist, Origin explícito para escritas com cookie, configuração faltante, instância incompatível, sanitização de logs e repasse do proxy Clerk com cookies.
- `pnpm run typecheck` → aprovado para bibliotecas, API, app e scripts.
- Build Vite → aprovado, 2.585 módulos, assets em `dist/public`; dry-run Wrangler 4.152.0 → aprovado, 8 assets, sem publicar.
- Pacotes Clerk atualizados dentro das faixas existentes e após `minimumReleaseAge`: `@clerk/react` 6.18.1, `@clerk/localizations` 4.24.1, `@clerk/express` 2.1.83, `@clerk/shared` 4.41.1. `@clerk/backend` permaneceu em 3.26.2.
- Workflows web e API reiniciados; o API-server compilou e iniciou. Capturas locais de `/` e `/sign-in` mostraram a página pública e o formulário Clerk com Google/e-mail.
- O navegador exibiu o aviso de chave de desenvolvimento esperado. O agente não concluiu login, não acessou o domínio Cloudflare e não verificou credenciais/Secrets de Runtime.
- A verificação do proxy é simulada: prova encaminhamento de uma requisição FAPI e retorno de `Set-Cookie`, não renovação de sessão real. Login Google/e-mail, origem e correspondência real das chaves seguem pendentes no Cloudflare Runtime.

T03 também confirmou que as duas chaves do Worker têm funções distintas: a chave pública verifica o JWT localmente, e a Secret é necessária para consultar a Backend API do Clerk e validar o e-mail principal. A Secret não é usada no navegador.

## T04 — Preparação do D1 de teste (bloqueada)

- `pnpm --filter @workspace/scripts d1:test-sqlite` → 4 testes locais aprovados; não usa conexão Cloudflare.
- `pnpm --filter @workspace/scripts exec wrangler whoami` → Wrangler não autenticado.
- Não foram executados `wrangler d1 list`, `wrangler d1 create`, SQL remoto, migrações ou deploy. Nenhum banco remoto foi acessado ou alterado.
- A conexão Cloudflare pelo Replit foi dispensada. O `database_id` em `wrangler.test.jsonc` continua igual ao principal e não pode ser usado para publicar.
- Alteração local independente: `run_worker_first` agora cobre `/api` e `/api/*`, como na configuração principal.
- Para retomar o provisionamento, autenticar Wrangler em Replit Shell via `pnpm --filter @workspace/scripts exec wrangler login`; depois confirmar apenas metadados e criar um D1 vazio separado. Não colar credenciais no chat.
- O documento T04 anexado descreve migração de dados; essa parte requer confirmação de escopo, destino e cópia recuperável antes de qualquer importação. O D1 vazio não será populado por suposição.

## Testes existentes e comandos atuais

- `pnpm --filter @workspace/zero3-pro-vendas run test` executa os testes Node existentes de vendas, importação/exportação, gráficos/relatórios de ocupação, auth/session, Worker helpers e custom fetch.
- `pnpm --filter @workspace/zero3-pro-vendas run test:workers` é um comando separado para os testes que usam o runtime Workers; a cobertura atual é limitada a sessão ausente e leitura do Scoreboard com D1 local.
- `pnpm --filter @workspace/api-server run test:integration` executa `sales.integration.test.ts`; os testes de ocupação e backup foram executados diretamente com `tsx --test` nesta etapa.
- Ainda faltam testes no Worker para CRUD, produtos/modalidades, importação, exportação, gráficos, ocupação e backups/restauração. A cobertura parcial de Scoreboard não equivale às 39 operações.
- `pnpm run typecheck` verifica o workspace; `pnpm run build` faz typecheck e builds recursivos.
- `pnpm --filter @workspace/zero3-pro-vendas run deploy:cloudflare:test:dry-run` requer chaves públicas/URL de proxy no build. Não executar enquanto o D1 de teste apontar para o mesmo ID do principal.

## Resultados T08 — validação local de release

- `pnpm install --frozen-lockfile` → concluído com pnpm 10.26.1. A integração oficial atual foi instalada como Vitest 4.1.12 e `@cloudflare/vitest-plugin` 1.4.7; o pacote antigo `@cloudflare/vitest-pool-workers` não é usado.
- `pnpm --filter @workspace/zero3-pro-vendas run test` → 95 passaram, 1 foi pulado (conferência manual da planilha original), 0 falharam.
- `pnpm --filter @workspace/zero3-pro-vendas run test:workers` → 2 passaram no runtime Workerd/Miniflare com D1 local efêmero e `remoteBindings: false`. Migrações de `scripts/d1/migrations` foram aplicadas; nenhuma configuração de D1 remoto foi carregada.
- O teste Workers exercita `GET /api/access-status` sem sessão (401) e a consulta real de Scoreboard do handler com duas vendas sintéticas em D1 (quantidade, total e resumo de dois meses conciliados). A consulta do handler recebe um ator de fixture; isso não é login Clerk nem teste de acesso autorizado pelo Worker.
- `pnpm run typecheck` → aprovado para os projetos do workspace.
- `PORT=5173 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/zero3-pro-vendas run build` → aprovado, Vite compilou 2.586 módulos e gerou `dist/public`. Permanecem avisos não bloqueantes de sourcemap e chunk acima de 500 KB.
- `pnpm --filter @workspace/scripts exec wrangler deploy --dry-run --config artifacts/zero3-pro-vendas/wrangler.jsonc --cwd ..` → Wrangler 4.152.0 empacotou 8 assets e mostrou `DB` ligado a `zero3-pro-gestao-db`; nenhum deploy ocorreu.
- `pnpm --filter @workspace/api-server run test:integration` → 10 testes de integração de vendas passaram. Os testes `occupancy.integration.test.ts` e `occupancy-backup.integration.test.ts` executados diretamente passaram (12 no total). São evidências Express, não Worker.
- `pnpm --filter @workspace/scripts exec wrangler whoami` → sem autenticação. Não foi feita reconciliação do painel nem consulta, migração ou alteração do D1 remoto.
- O D1 isolado da suíte usa `d1Databases: { DB: "zero3-vitest-local-only" }` em Miniflare; esse identificador é local e não é um ID Cloudflare. `wrangler.test.jsonc` permanece fora da suíte e continua inseguro para publicação por compartilhar o ID principal.

## Pendências T08

1. O Worker/D1 local cobre apenas autorização sem sessão e leitura mensal do Scoreboard; não executa CRUD completo nem todas as 39 operações.
2. Testar login Clerk Development real por Google/e-mail, origem, allowlist, renovação e logout no Worker `workers.dev`.
3. Executar E2E hospedado para venda/importação/edição, gráficos, ocupação manual/importada, exportação, backup/restauração, navegação, erro/retry e bloqueio pós-logout.
4. Testar datas limite, reprocessamento parcial, falhas transitórias e restauração repetida no D1 físico de homologação, que precisa ser separado e confirmado antes.
5. Registrar configuração live, versão do Worker, recursos, migrações/schema e origem de dados; isso está pendente porque `wrangler whoami` não está autenticado.
6. Registrar versão estável anterior e validar recuperação do D1 em ambiente isolado; nenhum procedimento remoto foi executado.
7. A ausência de consulta/escrita ao D1 remoto e de deploy foi confirmada nesta execução. A URL real de produção não foi testada; produção não pode ser declarada validada.

## Critérios funcionais extraídos da análise fornecida

- Importação de vendas deve testar múltiplas abas, todas as linhas com conteúdo, produto opcional, `Data de início` como prioridade e ausência de fallback para hoje.
- Ocupação precisa exercitar dados medidos (presenças/capacidade) e registros legados só com percentual, sem mistura indevida nem médias silenciosas.
- Relatórios precisam provar filtros de período próprios e visões separadas de Faturamento e Ocupação.
- Testes financeiros devem confirmar a data usada para contabilizar estornos antes de qualquer alteração dessa regra.
