---
name: Scripts TSX inline
description: Nota sobre executar verificações assíncronas com tsx -e neste workspace.
---

`tsx -e` compila o código inline como CommonJS e rejeita `await` no nível superior. Envolva o script em uma IIFE assíncrona e trate os erros explicitamente.

**Why:** verificações ad hoc do importador falharam durante a transformação, antes de executar o código, até usar esse padrão.

**How to apply:** em scripts de validação temporários, use `void (async () => { ... })().catch(...)` em vez de top-level await.
