# Checklist de aceite da migração Cloudflare

Atualizado em 2026-10-26, cruzando `CHECKLIST_ACEITE.md` com evidências presentes no workspace. Nenhum critério foi presumido como aprovado. Estados se aplicam somente ao escopo e ambiente descritos na evidência; “Aprovado local” não significa homologação Cloudflare.

## Evidências registradas

| Ref. | Ambiente e comando/cenário | Resultado observado | Limite |
| --- | --- | --- | --- |
| E01 | Workspace local; `PORT=5173 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/zero3-pro-vendas run build` | Vite compilou 2.584 módulos e gerou `dist/public`. Build concluído; avisos não bloqueantes de sourcemap e chunk acima de 500 KB. | Build do app filtrado; não é teste de navegação nem produção. |
| E02 | Workspace local; `pnpm --filter @workspace/scripts exec wrangler deploy --dry-run --config artifacts/zero3-pro-vendas/wrangler.jsonc --cwd ..` | Wrangler 4.152.0, 8 arquivos de assets lidos; dry-run terminou sem publicar e listou `DB` e `ASSETS`. A resolução 4.152.0 consta no lockfile. | Não valida Secrets, existência/identidade remota do D1, API real ou login. |
| E03 | Testes locais; `pnpm --filter @workspace/zero3-pro-vendas run test` | 33 testes passaram. Os cenários de auth chamam `Worker.fetch` com JWT assinado de fixture e consulta de perfil Clerk simulada; cobrem falta/invalidade/expiração, allowlist e erros de configuração. | Não é login Clerk real nem Worker hospedado; não usa D1. |
| E04 | Inspeção estática de `wrangler.jsonc` e `wrangler.test.jsonc` | Os dois arquivos têm o mesmo `database_id`, embora a configuração de teste use nome de banco/Worker de teste. | Evidência suficiente para bloquear deploy de homologação com a configuração atual. |

## Resultado por critério

Para critérios “Não executado”, o ambiente de homologação/produção, o cenário e os dados de teste não foram exercitados: não há comando ou resultado observado a registrar. O critério permanece aberto, não aprovado.

| ID | Área e esperado | Resultado | Evidência observada / comando | Próximo passo |
| --- | --- | --- | --- | --- |
| A01 | Cobertura: cada função ligada à tela, API, dados e teste | Não executado | T01 criou inventário por grupo funcional; não validou cada operação individual ponta a ponta. | Completar matriz por operação em T02–T08. |
| A02 | Instalação limpa com pnpm fixado e frozen-lockfile | Não executado | Nenhuma instalação limpa foi feita nesta auditoria. | Executar instalação limpa com pnpm 10.26.1 e lockfile congelado. |
| A03 | Build somente do gestor e dependências necessárias; sem variáveis ocultas | Aprovado local | E01; `PORT` e `BASE_PATH` foram explícitos no comando. | Repetir como parte da instalação limpa. |
| A04 | Configuração/entrypoint corretos, Wrangler fixado e dry-run aprovado | Aprovado no dry-run local | E02; Wrangler 4.152.0 resolvido pelo lockfile; dry-run não publicou. | Manter escopo local; validar rotas no runtime em homologação. |
| A05 | Execução sem servidor, proxy, storage, domínio ou conector exclusivo Replit | Não executado | Não houve teste integrado na URL Cloudflare. | Testar frontend e API no Worker hospedado. |
| A06 | Navegação direta funciona; `/api` retorna JSON e 404 adequado | Reprovado — resposta desconhecida | Inspeção estática: `src/worker/index.ts` retorna 501 para rota API não reconhecida; navegação direta não foi testada no destino. | Corrigir 501 para 404 adequado e testar SPA, JSON e rotas desconhecidas no Worker. |
| A07 | Teste, homologação e produção com recursos físicos isolados | Reprovado — configuração atual | E04; `wrangler.test.jsonc` compartilha o ID D1 da configuração principal. | Criar/configurar D1 de teste independente e confirmar ID antes de deploy. |
| A08 | Login, logout e renovação Clerk com instância/origens coerentes | Não executado | E03 é fixture local; nenhum ciclo real de sessão foi testado. | Testar Clerk Development no domínio de homologação. |
| A09 | 401, 403 e indisponibilidade distintos; sem fallback de admin | Aprovado local/simulado | E03; Worker local rejeita tokens e usuário fora da allowlist; sem Clerk/D1 real. | Confirmar comportamento no Worker hospedado e com serviço Clerk real. |
| A10 | Build/Runtime documentados; secrets ausentes de frontend/Git/logs | Não executado integralmente | Documentação de variáveis criada; Runtime e logs Cloudflare não foram inspecionados. | Validar configuração e logs do Worker sem revelar valores. |
| A11 | Binding e ID D1 reais, migrations conhecidas e persistência entre sessões | Não executado | Migrações versionadas foram localizadas; dry-run não consulta o banco. | Confirmar D1 remoto de homologação e persistência após nova sessão. |
| A12 | Migração conciliada por contagens, IDs, vínculos e totais | Não executado no destino | Manifesto local registra 1.360 linhas; não comprova migração remota. | Conciliar origem e D1 de teste na T04. |
| A13 | Migração/reprocessamento sem duplicar ou apagar registros legítimos | Não executado nesta auditoria | Script local tem verificações de conflito/idempotência; nenhum ensaio foi executado nesta etapa. | Executar repetição e conflito na cópia local e homologação isolada. |
| A14 | Vendas manuais/editadas e demais ações atualizam interface e banco | Não executado no Worker/D1 | Há implementação e testes Express, mas sem fluxo de vendas no Worker com D1. | Validar CRUD e atualização das telas na T05. |
| A15 | Importação financeira de todas as abas/blocos; produto opcional | Não executado no destino | Critérios foram registrados; arquivo real não foi validado no Worker. | Testar arquivo real com múltiplas abas e produto ausente na T05. |
| A16 | Data de início prioritária, sem fallback para data atual | Não executado no destino | Regra registrada; sem ensaio integrado no Worker. | Testar datas e ausência de data na T05. |
| A17 | Dados inválidos rastreáveis, sem erro/vazio convertido em zero | Não executado | Sem cenário de importação no runtime de homologação. | Cobrir valores ausentes, fórmulas sem cache e erros rastreáveis. |
| A18 | Scoreboard confere com fonte canônica, período e paginação | Não executado no Worker/D1 | Existem testes locais de utilitários; não houve conciliação no destino. | Conferir filtros, paginação e total no Worker/D1. |
| A19 | Gráficos financeiros usam a mesma base/filtros e tratam centavos/negativos | Não executado no destino | Testes unitários existem, mas o script padrão não executa todos. | Executar testes e comparar gráficos com Scoreboard. |
| A20 | Ocupação diária/mensal, modalidade/horários, entrada manual e importação | Não executado no Worker/D1 | Rotas e testes Express existem; homologação Worker não foi exercitada. | Testar criação, edição, importação e filtros na T06. |
| A21 | Regra real de ocupação documentada; sem somar taxas ou inventar contagens | Não executado integralmente | O esquema preserva medições e percentuais legados; falta validar todas as origens/relatórios integrados. | Confrontar origem, cálculo e exibição em T06. |
| A22 | Zero distinto de “Sem dados”; divisão por zero vira pendência | Não executado no destino | Não houve roteiro integrado de ausências. | Testar zero, ausência de registros e capacidade zero. |
| A23 | Relatórios usam período próprio e não alteram filtros dos painéis | Não executado no destino | Helpers/tests locais existem; fluxo de interface integrado não foi verificado. | Testar período independente em relatórios financeiros e de ocupação. |
| A24 | XLSX/CSV reais conferidos com leitor independente | Não executado | Nenhum arquivo real foi exportado e conferido nesta auditoria. | Exportar/importar XLSX e CSV em homologação e conferir conteúdo independentemente. |
| A25 | Cenário representativo dentro dos limites do destino | Não executado | Nenhum teste de volume/limites do Workers/D1 foi feito. | Executar com volume representativo em D1 isolado. |
| A26 | Backup completo versionado, com IDs/vínculos e módulos esperados | Não executado no destino | Contratos/código de backup existem; não houve backup real integrado. | Gerar e inspecionar backup completo na T07. |
| A27 | Backup parcial identifica escopo, dependências e totais | Não executado no destino | Nenhum backup parcial de homologação foi gerado. | Validar escopo e dependências em T07. |
| A28 | Restauração isolada conciliada e repetível sem duplicação | Não executado | Nenhuma restauração em ambiente isolado Cloudflare foi feita. | Restaurar em D1 de teste e repetir com comparação de IDs/totais. |
| A29 | UI termina carregamento e distingue erro/vazio/retry/filtros | Não executado no navegador Cloudflare | Preview local não representa o runtime e não foi usado para esta aceitação. | Executar roteiro interativo em homologação. |
| A30 | Fluxos reais no Workers e na homologação Cloudflare | Não executado | E01–E03 são validações locais; nenhuma URL de homologação foi testada. | Executar roteiro integrado T08 após isolar o D1. |
| A31 | Logs sanitizados, correlação e diagnóstico operacional | Não executado no Runtime | Testes locais cobrem sanitização; logs de Worker hospedado não foram examinados. | Validar campos técnicos seguros e Ray ID em homologação. |
| A32 | Recuperação de código e dados com procedimentos separados | Não executado | Procedimentos estão documentados, mas não houve ensaio de recuperação de dados. | Fazer exercício de recuperação isolado; não confundir rollback de código com recuperação D1. |
| A33 | Entrega com commit/versão/comandos/evidências/pendências | Aprovado para T01 apenas | Commits `7a1ed72` e `986fc08`; inventário, estado e comandos/evidências registrados. | Repetir o registro a cada etapa; a entrega da migração completa permanece aberta. |

## Conclusão de aceite atual

T01 está documentada. Os resultados locais de build/dry-run e autenticação são evidências limitadas de seus próprios cenários. A migração completa **não está aprovada**: a configuração de D1 de teste está reprovada por compartilhar o ID do banco principal, e a maioria dos critérios integrados ainda não foi executada.
