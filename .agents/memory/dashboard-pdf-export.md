---
name: Exportação PDF do painel
description: Abordagem para gerar relatórios visuais do dashboard completo com valores legíveis.
---

Para relatórios do painel, o fluxo de impressão do navegador preserva os gráficos SVG e o texto como conteúdo vetorial; complemente cada gráfico com uma tabela textual dos valores e filtros atuais. Exporte painéis individuais por escopo, sem imprimir os gráficos vizinhos, e mantenha a opção de relatório completo.

**Why:** um PDF somente com imagem pode reduzir a legibilidade de valores e impede a seleção de texto; preservar vetores e tabelas mantém cores e números claros sem adicionar uma biblioteca de PDF.

**How to apply:** use CSS de impressão com identidade visual, quebras de página, título e metadados dos filtros atuais; no modo individual, inclua apenas o painel selecionado. Explique que o usuário deve escolher “Salvar como PDF” no diálogo do navegador.

Ao filtrar painéis individuais, deixe a regra global que esconde os painéis como `display: none` sem `!important`, e aplique `display: block !important` somente ao escopo selecionado. Dois `!important` podem fazer o seletor global, mais específico, ocultar também o painel escolhido e gerar PDF em branco. Para tabelas longas, repita o `thead`, evite dividir cada `tr` e mantenha o título junto à tabela; não force `break-inside: avoid` em todo o painel/tabela quando o conteúdo excede uma página.

**Why:** a cascata de impressão pode dar prioridade à regra de ocultação global, e `break-inside: avoid` em tabelas que passam de uma página produz quebras ruins ou páginas quase vazias.

**How to apply:** valide cada escopo de exportação com um PDF sintético, incluindo resumo, detalhes com continuação e um painel individual; confira páginas, orientação, conteúdo e imagem renderizada, não apenas texto extraído.
