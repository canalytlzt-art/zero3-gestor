---
name: Vínculo de modalidade por venda
description: Semântica do vínculo direto da venda e compatibilidade com a associação histórica do produto.
---

Vendas legadas devem continuar usando a modalidade associada ao produto. Uma venda com escolha explícita usa sua própria modalidade; o valor explícito nulo significa que a venda deve permanecer sem classificação, mesmo que o produto tenha modalidade.

**Why:** o mesmo produto pode ser vendido em modalidades diferentes, enquanto vendas existentes não devem ser reescritas em massa nem mudar seus relatórios.

**How to apply:** nos relatórios, use a modalidade da venda somente quando houver substituição explícita; caso contrário, derive-a do produto. Preserve ambos os campos em edição e backup. Nunca crie check-ins ou presenças a partir de vendas.
