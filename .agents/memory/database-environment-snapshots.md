---
name: Seleção do banco por ambiente
description: Regras para exportar ou validar dados de desenvolvimento sem risco de conectar ao banco errado.
---

Use uma operação de banco que permita escolher explicitamente `development` para auditorias, cópias e testes de migração. Não conclua que a conexão padrão do processo é de desenvolvimento apenas porque o comando foi iniciado no workspace ou porque `NODE_ENV` foi definido.

**Why:** O processo de shell pode indicar um ambiente diferente do banco de desenvolvimento exposto pelo conector; escolher a conexão errada colocaria dados de produção em risco.

**How to apply:** Antes de exportar dados, confirme a origem pelo acesso explicitamente direcionado ao ambiente de desenvolvimento. Evite usar a conexão padrão da aplicação para gerar cópias se o ambiente efetivo não estiver verificado.

Para verificar uma cópia D1 local com Wrangler, use `--local` e passe explicitamente o mesmo `--persist-to` usado na importação. Sem ele, Wrangler pode consultar outra cópia local e indicar migrações pendentes que já foram aplicadas na cópia correta.

**Why:** As configurações e diretórios padrão de persistência do Wrangler podem manter bancos locais independentes, embora usem o mesmo nome lógico.

**How to apply:** Reutilize o diretório de persistência validado em `d1 migrations list`, `d1 execute` e `wrangler dev`; não use `--remote` para esse teste.

Para testes de runtime Workers, configure explicitamente D1 local no Miniflare e `remoteBindings: false`. Não carregue uma configuração Wrangler de teste enquanto seu `database_id` for igual ao D1 principal: nomes lógicos distintos não isolam o recurso remoto.

**Why:** Um teste pode parecer isolado pelo nome do Worker/banco e ainda apontar para o mesmo banco produtivo pelo ID.

**How to apply:** Compare os IDs antes de qualquer execução remota. Se não houver D1 físico exclusivo, use binding local efêmera para testes Workers e deixe a publicação de homologação bloqueada.

Na versão instalada `@cloudflare/vitest-plugin` 1.4.7, `readD1Migrations` é exportado pelo pacote raiz, embora a documentação consulte um subcaminho `/config`. Confira os `exports` da versão resolvida antes de copiar o caminho de importação da documentação.

**Why:** O subcaminho documentado não está exportado por essa versão e falha na resolução do módulo.

**How to apply:** Para outras versões, confira novamente o campo `exports` do pacote instalado; não assuma que o caminho permanece igual.
