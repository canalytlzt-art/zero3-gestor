# Matriz de testes Cloudflare

## Evidência registrada

Na última validação anterior à auditoria T01: 33 testes do app passaram, assim como typecheck, build Vite e `wrangler deploy --dry-run`. Esses resultados cobrem código local e empacotamento; não comprovam login real, D1 remoto ou deploy integrado.

Nesta auditoria não foram executados testes nem comandos de banco.

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

## Critérios funcionais extraídos da análise fornecida

- Importação de vendas deve testar múltiplas abas, todas as linhas com conteúdo, produto opcional, `Data de início` como prioridade e ausência de fallback para hoje.
- Ocupação precisa exercitar dados medidos (presenças/capacidade) e registros legados só com percentual, sem mistura indevida nem médias silenciosas.
- Relatórios precisam provar filtros de período próprios e visões separadas de Faturamento e Ocupação.
- Testes financeiros devem confirmar a data usada para contabilizar estornos antes de qualquer alteração dessa regra.
