---
name: Compatibilidade entre relatórios e importação de ocupação
description: Regras não óbvias para que planilhas exportadas possam voltar a ser importadas sem linhas pendentes falsas.
---

A aba detalhada do relatório de ocupação deve manter o formato aceito pelo importador: modalidade, data, horários inicial/final, presenças/vagas combinadas, percentual e turma. Não misture a coluna única “Horário” com “Horário final”; o importador trata esse par como ambíguo. Abas de resumo e comparação não devem ser interpretadas como registros importáveis.

**Why:** o importador pode transformar abas sem cabeçalho compatível em linhas pendentes; uma planilha de relatório retornada para importação também não deve apresentar registros falsos ou ambíguos.

**How to apply:** ao alterar os cabeçalhos ou nomes das abas do relatório, mantenha um teste de ida e volta que exporte um XLSX com todas as abas e passe o arquivo pelo importador, conferindo contagens e horários.
