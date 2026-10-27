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

- `pnpm --filter @workspace/zero3-pro-vendas run test` chama um subconjunto explícito: vendas utilitárias/workbook/export, auth/session e custom fetch.
- Há arquivos de teste adicionais não incluídos nesse script: `sales-import.test.ts`, `occupancy-import.test.ts`, testes de relatórios, charts e dados de gráficos.
- `pnpm --filter @workspace/api-server run test:integration` executa apenas `sales.integration.test.ts`.
- `occupancy.integration.test.ts` e `occupancy-backup.integration.test.ts` existem, mas não fazem parte desse comando.
- Não há teste de integração do Worker para as rotas de vendas e ocupação; há testes de auth/session e helpers.
- `pnpm run typecheck` verifica o workspace; `pnpm run build` faz typecheck e builds recursivos.
- `pnpm --filter @workspace/zero3-pro-vendas run deploy:cloudflare:test:dry-run` requer chaves públicas/URL de proxy no build. Não executar enquanto o D1 de teste apontar para o mesmo ID do principal.

## Lacunas para T08

1. Executar todos os testes existentes e ajustar scripts para não deixar testes funcionais fora do fluxo padrão.
2. Testar endpoints de negócio no runtime Workers com D1 isolado.
3. Testar login Clerk Development real, origem autorizada, allowlist, ausência/expiração/rejeição de sessão.
4. Conferir exportações/restaurações e conciliar Scoreboard, vendas, estornos e ocupação.
5. Guardar evidência de que produção não foi alterada durante os testes.
6. Testar as 39 operações com comportamento/persistência real em Workers e D1 isolado; a verificação T02 foi de presença estática, com smoke limitado.

## Critérios funcionais extraídos da análise fornecida

- Importação de vendas deve testar múltiplas abas, todas as linhas com conteúdo, produto opcional, `Data de início` como prioridade e ausência de fallback para hoje.
- Ocupação precisa exercitar dados medidos (presenças/capacidade) e registros legados só com percentual, sem mistura indevida nem médias silenciosas.
- Relatórios precisam provar filtros de período próprios e visões separadas de Faturamento e Ocupação.
- Testes financeiros devem confirmar a data usada para contabilizar estornos antes de qualquer alteração dessa regra.
