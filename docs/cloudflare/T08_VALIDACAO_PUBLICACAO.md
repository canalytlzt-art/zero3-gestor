# T08 — Validação e prontidão para publicação

## Resultado

**Validação local concluída; publicação não liberada.** O conjunto local passou por instalação congelada, typecheck, testes Node, testes Workers com D1 Miniflare, build e dry-run da configuração principal. Homologação Cloudflare e produção continuam pendentes.

O bloqueio é concreto: Wrangler não está autenticado e `wrangler.test.jsonc` ainda referencia o mesmo `database_id` da configuração principal. Não publique o Worker de teste com essa configuração. A suíte Vitest criada para esta etapa usa D1 estritamente local, não usa esse arquivo e define `remoteBindings: false`.

## Status por ambiente

| Ambiente | Status | Evidência/limite |
| --- | --- | --- |
| Workspace local | **Concluído e verificado** | pnpm 10.26.1 com frozen lockfile; typecheck; 95 testes Node aprovados e 1 pulado; 2 testes Workers/D1 aprovados; 22 testes Express de integração aprovados; build Vite e dry-run Wrangler principal aprovados. |
| Workers/Miniflare local | **Concluído e verificado, cobertura parcial** | D1 local efêmero recebeu migrações. O Worker rejeitou sessão ausente com 401; o handler do Scoreboard reconciliou duas vendas sintéticas em outubro/novembro. O handler de negócio recebeu ator sintético; Clerk real não foi usado. |
| Cloudflare `workers.dev` de homologação | **Pendente** | Wrangler não autenticado; D1 físico separado não confirmado; Clerk Development/Secrets não verificados; nenhuma URL de homologação foi publicada ou testada. |
| Worker de produção `zero3-gestor` | **Pendente** | Dry-run local apenas. Não houve deploy, inspeção de versão/Runtime, teste da URL real, leitura ou escrita do D1 remoto. Não declarar produção validada. |

## Evidências locais

- Instalação: `pnpm install --frozen-lockfile` — concluída com pnpm 10.26.1.
- Typecheck: `pnpm run typecheck` — aprovado.
- App: `pnpm --filter @workspace/zero3-pro-vendas run test` — 95 aprovados, 1 pulado, 0 falhas. O teste pulado requer conferência manual de uma planilha original.
- Worker: `pnpm --filter @workspace/zero3-pro-vendas run test:workers` — 2 aprovados em Vitest 4.1.12, `@cloudflare/vitest-plugin` 1.4.7, Workerd/Miniflare e D1 local.
- Express: integração de vendas — 10 aprovados; integração de ocupação/backup — 12 aprovados. São testes da API Express, não substituem execução do Worker.
- Build: `PORT=5173 BASE_PATH=/ NODE_ENV=production pnpm run build` — typecheck e builds recursivos do monorepo aprovados; Vite transformou 2.586 módulos e gerou `artifacts/zero3-pro-vendas/dist/public`. Permanecem avisos de sourcemap e chunk acima de 500 KB.
- O mesmo build passou com ambiente de processo limpo (`env -i`, mantendo apenas `PATH`, `HOME`, `PORT`, `BASE_PATH` e `NODE_ENV`). Isso não verifica valores Clerk de Runtime nem substitui a inspeção de qualquer arquivo `.env` local.
- Dry-run: `pnpm --filter @workspace/scripts exec wrangler deploy --dry-run --config artifacts/zero3-pro-vendas/wrangler.jsonc --cwd ..` — Wrangler 4.152.0, 8 assets, `DB` configurado para `zero3-pro-gestao-db`; encerrou sem publicar.
- O workflow web foi reiniciado e a landing pública apareceu no preview local. O console mostrou aviso de chave Clerk de desenvolvimento e falha não bloqueante ao criar o provedor WebGPU; não houve login nem validação da interface autenticada.
- Conta: `pnpm --filter @workspace/scripts exec wrangler whoami` — “You are not authenticated.” Nenhuma operação D1 remota foi executada.

## Critérios ainda sem evidência remota

O inventário completo dos critérios A01–A33 permanece em [`ACEITE.md`](./ACEITE.md). Em particular, estão pendentes:

- Autenticação real Clerk Development por Google e e-mail, sessão/renovação/logout, allowlist e permissões no Worker hospedado.
- Confirmar a configuração live de Secrets/vars e a origem das chaves; os valores nunca devem ser registrados.
- Criar/confirmar um D1 remoto vazio e exclusivo para homologação, verificar seu ID contra produção e corrigir `wrangler.test.jsonc`.
- Exercitar vendas CRUD/importação, Scoreboard, gráficos, ocupação CRUD/importação, XLSX/CSV, backups/restauração e as 39 operações no Worker de homologação.
- Verificar navegação direta, estados vazio/erro/retry, perda temporária de rede, exports/backups e ausência de dependência do servidor Replit.
- Registrar versão publicada, commit, bindings/recursos, schema aplicado, origem dos dados, versão estável anterior e recuperação D1 após inspeção autenticada do painel.
- Testar a URL real de produção apenas depois de publicação autorizada.

## Comandos seguros para retomar

1. Autenticar Wrangler pelo fluxo interativo `pnpm --filter @workspace/scripts exec wrangler login`; confirmar com `pnpm --filter @workspace/scripts exec wrangler whoami`.
2. No painel, identificar/criar um D1 vazio de teste e confirmar que seu ID é diferente do D1 principal. Não importar snapshot nesta etapa.
3. Atualizar `wrangler.test.jsonc` somente com o ID confirmado; revisar variáveis e Secrets Clerk do mesmo ambiente Development.
4. Reexecutar o inventário e o checklist antes de publicar `zero3-gestor-teste`; qualquer publicação exige autorização específica.
5. Não publicar em produção nem migrar/restaurar dados como parte desta entrega.

## Arquivos específicos de T08

- `artifacts/zero3-pro-vendas/package.json`
- `artifacts/zero3-pro-vendas/vitest.config.ts`
- `artifacts/zero3-pro-vendas/src/worker/worker-runtime.workers.test.ts`
- `artifacts/zero3-pro-vendas/src/worker/workers-test-setup.mjs`
- `pnpm-lock.yaml`
- `docs/cloudflare/ACEITE.md`
- `docs/cloudflare/CONFIGURACAO.md`
- `docs/cloudflare/INVENTARIO.md`
- `docs/cloudflare/OPERACAO.md`
- `docs/cloudflare/ESTADO.md`
- `docs/cloudflare/TESTES.md`
- `docs/cloudflare/T08_VALIDACAO_PUBLICACAO.md`

Não foi criado commit nem enviado push nesta etapa. Há outras alterações locais anteriores de T05–T07 no workspace; elas foram preservadas e não são apresentadas como parte exclusiva da T08.
