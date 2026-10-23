---
name: Seleção do banco por ambiente
description: Regras para exportar ou validar dados de desenvolvimento sem risco de conectar ao banco errado.
---

Use uma operação de banco que permita escolher explicitamente `development` para auditorias, cópias e testes de migração. Não conclua que a conexão padrão do processo é de desenvolvimento apenas porque o comando foi iniciado no workspace ou porque `NODE_ENV` foi definido.

**Why:** O processo de shell pode indicar um ambiente diferente do banco de desenvolvimento exposto pelo conector; escolher a conexão errada colocaria dados de produção em risco.

**How to apply:** Antes de exportar dados, confirme a origem pelo acesso explicitamente direcionado ao ambiente de desenvolvimento. Evite usar a conexão padrão da aplicação para gerar cópias se o ambiente efetivo não estiver verificado.
