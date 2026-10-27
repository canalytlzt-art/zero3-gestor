---
name: Autenticação Wrangler não interativa
description: Diferença entre a verificação `wrangler whoami` e credenciais aceitas por comandos remotos em processos não interativos.
---

Não trate `wrangler whoami` com código de saída zero como prova suficiente de que comandos remotos D1 funcionarão em execução não interativa. Os comandos de D1 podem exigir que `CLOUDFLARE_API_TOKEN` esteja disponível no ambiente protegido do workspace, mesmo quando a verificação de identidade local termina sem erro.

**Why:** Uma tentativa de listar migrations e consultar apenas o catálogo SQLite foi bloqueada no processo não interativo, que informou não haver token de API disponível, apesar da verificação anterior ter retornado sucesso.

**How to apply:** Antes de declarar o acesso remoto disponível, execute uma operação somente de leitura de metadados necessária ao diagnóstico; não exponha nem leia o valor do token. Se falhar, pare e use o fluxo de Secrets/autenticação do workspace.
