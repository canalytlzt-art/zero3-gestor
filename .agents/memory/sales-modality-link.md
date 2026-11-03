---
name: Vínculo de modalidade por venda
description: Semântica do vínculo direto da venda e compatibilidade com a associação histórica do produto.
---

Vendas legadas devem continuar usando a modalidade atual associada ao produto. Uma venda com escolha explícita usa sua própria modalidade; o valor explícito nulo significa que a venda deve permanecer sem classificação, mesmo que o produto tenha modalidade. Para vendas antigas sem `product_id`, associe a categoria em leitura somente se o nome normalizado corresponder exatamente a um único produto. Nunca grave esse vínculo como efeito colateral da consulta; nomes ambíguos ou sem correspondência ficam sem associação e são sinalizados.

**Why:** o mesmo produto pode ser vendido em modalidades diferentes, e a reclassificação deve acompanhar a categoria atual do cadastro sem reescrever lançamentos ou adivinhar vínculos históricos.

**How to apply:** nos relatórios, use a modalidade da venda somente quando houver substituição explícita; caso contrário, derive-a do produto. Para registros sem ID, use apenas uma correspondência única de nome normalizado e mantenha o ID armazenado intacto. Preserve os campos diretos em edição e backup. Nunca crie check-ins ou presenças a partir de vendas.
