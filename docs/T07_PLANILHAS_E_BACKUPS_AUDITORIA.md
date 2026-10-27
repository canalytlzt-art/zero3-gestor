# T07 — Auditoria de planilhas e backups

## Escopo

Auditoria e testes com dados sintéticos. Não foram lidos arquivos reais de vendas ou ocupação, consultado qualquer banco D1, executada uma restauração em banco, publicado o Worker ou criado um commit.

## O que foi verificado

- As exportações financeiras criam um `.xlsx` real com as abas `Lançamentos` e `Resumo por plano`; o CSV usa separador brasileiro e os valores continuam numéricos nos relatórios.
- Os filtros de vendas aceitam meses e intervalos inclusivos; o resumo concilia quantidade, vendas, estornos e líquido. A exportação inclui mais de uma página de registros.
- As versões 1, 2 e 3 de backup financeiro continuam aceitas pelo leitor, com validação de contagens e relações na versão atual.
- Os relatórios de ocupação criam `.xlsx` com a aba detalhada compatível com a importação, além das abas de resumo e comparação. A seleção de período, modalidade, horários, dias da semana e intervalos parciais é preservada.
- A restauração de ocupação valida versão, IDs, modalidades, contagens e relações antes de permitir confirmação. O arquivo é limitado a 8 MiB.
- Um leitor independente, usando somente a biblioteca padrão Python para abrir o ZIP/OpenXML, verificou os nomes das abas, as células e a ausência de células de fórmula nas planilhas exportadas. O ambiente não tem Excel nem LibreOffice para uma abertura visual em aplicativo de escritório.
- CSV agora neutraliza textos que começam com `=`, `+`, `-` ou `@`, inclusive após espaços, sem converter valores numéricos negativos em texto.

## Correções feitas

- O backup de ocupação do Worker informava a quantidade total de registros de todo o banco, mesmo quando o arquivo continha apenas um período. Agora `totalRecords` corresponde aos registros efetivamente incluídos, como exige o leitor usado na restauração.
- O Worker agora filtra por período, intervalo, modalidade, turma, horário e dia da semana na consulta D1 e limita a leitura de candidatos a 50.001 registros; acima de 50.000, a geração falha explicitamente.
- Resumos de backup agora usam a mesma precedência efetiva da ocupação: registros mensais não entram em intervalos que não cobrem o mês inteiro, e resumos mensais substituem o registro legado diário do mesmo escopo.
- O limite do Worker foi alinhado a 8 MiB, igual ao leitor e à API.
- Os botões de exportação de ocupação ficam indisponíveis enquanto a consulta dos filtros está em andamento, evitando exportar dados anteriores aos filtros recém-selecionados.
- O download do relatório de ocupação mantém a URL temporária ativa por um curto intervalo antes de revogá-la.

## Validação executada

- Testes do app: **95 passaram, 1 foi ignorado**.
- Typecheck: passou.
- Build Vite de produção: passou usando `PORT=5173 BASE_PATH=/ NODE_ENV=production`.
- `git diff --check`: passou.
- As novas fixtures exercitam backup Worker para meses selecionados, intervalo parcial, mês vazio, IDs e contagens, além de um arquivo financeiro com mais de 500 registros.

O teste ignorado é a conferência das seis abas da planilha original e das linhas 29/30 de março; esta execução permaneceu com dados sintéticos conforme o escopo aprovado.

## Limites restantes

- Não foi executada restauração de ponta a ponta em D1 isolado: esse banco de teste ainda não está disponível nesta execução. Os testes do Worker usam um D1 falso em memória; portanto não provam a integração real com Cloudflare D1.
- Não foi executado teste de carga em um Worker publicado. O limite implementado é 50.000 registros e 8 MiB por arquivo, mas a latência real do serviço não foi medida.
- Não foi feita abertura manual em Excel/LibreOffice, indisponíveis no ambiente.
- Os testes de integração do servidor que dependem de PostgreSQL não foram executados. Nenhum banco, dado financeiro ou dado de ocupação foi alterado.
- O build apresenta avisos já existentes sobre sourcemaps de componentes e o bundle principal acima de 500 kB; a compilação terminou com sucesso.

## Arquivos desta etapa

- `artifacts/zero3-pro-vendas/package.json`
- `artifacts/zero3-pro-vendas/src/components/occupancy-reports-dialog.tsx`
- `artifacts/zero3-pro-vendas/src/lib/occupancy-report.ts`
- `artifacts/zero3-pro-vendas/src/lib/occupancy-report.test.ts`
- `artifacts/zero3-pro-vendas/src/lib/occupancy-backup-file.test.ts`
- `artifacts/zero3-pro-vendas/src/lib/sales-export.test.ts`
- `artifacts/zero3-pro-vendas/src/lib/sales-workbook.ts`
- `artifacts/zero3-pro-vendas/src/lib/sales-workbook.test.ts`
- `artifacts/zero3-pro-vendas/src/lib/spreadsheet-csv-safety.ts`
- `artifacts/zero3-pro-vendas/src/lib/spreadsheet-csv-safety.test.ts`
- `artifacts/zero3-pro-vendas/src/lib/xlsx-openxml-test-utils.ts`
- `artifacts/zero3-pro-vendas/src/worker/occupancy.ts`
- `artifacts/zero3-pro-vendas/src/worker/occupancy-backup.test.ts`
- `docs/T07_PLANILHAS_E_BACKUPS_AUDITORIA.md`
