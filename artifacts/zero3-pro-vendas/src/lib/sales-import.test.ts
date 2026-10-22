import assert from "node:assert/strict";
import { test } from "node:test";
import * as XLSX from "xlsx";
import {
  mapSalesImportRow,
  parseImportDate,
  parseImportMoney,
  parseSalesSpreadsheet,
} from "./sales-import";

test("detects headers after preface rows, preserves start dates, and reads multiple sheets", async () => {
  const workbook = XLSX.utils.book_new();
  const visible = XLSX.utils.aoa_to_sheet([
    ["Relatório mensal de vendas"],
    [],
    ["Nome do cliente", "Data de vencimento", "Data de início", "Valor da venda"],
    [" Ana  Silva ", "2026-12-10", "03/10/2026", "R$ 1.234,56"],
    ["Ana Silva", "2026-12-11", 46299, 1234.57],
    ["Total geral", "", "", "R$ 2.469,13"],
    [],
  ]);
  const hidden = XLSX.utils.aoa_to_sheet([
    ["Cliente", "Data de início", "Valor total"],
    ["Cliente oculto", "2026-10-07", "100,00"],
  ]);
  XLSX.utils.book_append_sheet(workbook, visible, "Vendas");
  XLSX.utils.book_append_sheet(workbook, hidden, "Importar também");
  workbook.Workbook = {
    Sheets: [
      { name: "Vendas", Hidden: 0 },
      { name: "Importar também", Hidden: 1 },
    ],
  };
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

  const parsed = await parseSalesSpreadsheet(bytes, "relatorio.xlsx");
  assert.equal(parsed.sheets.length, 2);
  const sheet = parsed.sheets[0];
  assert.equal(sheet.headerRow, 3);
  assert.equal(sheet.mapping.customerName, 0);
  assert.equal(sheet.mapping.saleDate, 2, "Data de início wins over Data de vencimento");
  assert.equal(sheet.mapping.totalAmount, 3);
  assert.equal(sheet.rows.length, 2, "subtotal and blank rows are excluded");
  assert.equal(sheet.ignoredSummaryRows, 1);
  assert.equal(sheet.selected, true);
  assert.equal(parsed.sheets[1].hidden, true);
  assert.equal(parsed.sheets[1].selected, false);

  const first = mapSalesImportRow(sheet, sheet.rows[0]);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.value, {
    key: "Vendas:4",
    sourceSheet: "Vendas",
    sourceRow: 4,
    customerName: "Ana Silva",
    saleDate: "2026-10-03",
    totalCents: 123456,
    productName: null,
  });
  const second = mapSalesImportRow(sheet, sheet.rows[1]);
  assert.equal(second.value?.saleDate, "2026-10-04");
  assert.equal(second.value?.totalCents, 123457);

  const noHeaderWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    noHeaderWorkbook,
    XLSX.utils.aoa_to_sheet([
      ["Primeira cliente", "2026-10-08", "123,45"],
      ["Segunda cliente", "2026-10-09", "50,00"],
    ]),
    "Sem cabeçalho",
  );
  const noHeader = await parseSalesSpreadsheet(
    XLSX.write(noHeaderWorkbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    "sem-cabecalho.xlsx",
  );
  assert.equal(noHeader.sheets[0].headerRow, null);
  assert.equal(noHeader.sheets[0].rows.length, 2, "manual mapping does not discard the first data row");
});

test("accepts quoted CSV and exact Brazilian/ISO/Excel values while rejecting invalid money and dates", async () => {
  const csv = [
    "Relatório",
    "",
    "Nome do cliente,Data de início,Valor da venda",
    '"Cliente, Teste",2026-10-05,"R$ 1.234,56"',
  ].join("\n");
  const encoded = new TextEncoder().encode(csv);
  const parsed = await parseSalesSpreadsheet(
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
    "vendas.csv",
  );
  const row = mapSalesImportRow(parsed.sheets[0], parsed.sheets[0].rows[0]);
  assert.deepEqual(row.errors, []);
  assert.equal(row.value?.customerName, "Cliente, Teste");
  assert.equal(row.value?.totalCents, 123456);

  assert.equal(parseImportMoney("R$ 2.050,01"), 205001);
  assert.equal(parseImportMoney("1.234,56"), 123456);
  assert.equal(parseImportMoney(1234.56), 123456);
  assert.equal(parseImportMoney("-10,00"), null);
  assert.equal(parseImportMoney("10,999"), null);
  assert.equal(parseImportMoney(""), null);
  assert.equal(parseImportDate("2026-10-05"), "2026-10-05");
  assert.equal(parseImportDate("05/10/2026"), "2026-10-05");
  const serial1904 = (Date.UTC(2026, 9, 5) - Date.UTC(1904, 0, 1)) / 86_400_000;
  assert.equal(parseImportDate(serial1904, true), "2026-10-05");
  assert.equal(parseImportDate("31/02/2026"), null);
  await assert.rejects(
    parseSalesSpreadsheet(new ArrayBuffer(4), "arquivo.xls"),
    /Formato não suportado/,
  );
});
