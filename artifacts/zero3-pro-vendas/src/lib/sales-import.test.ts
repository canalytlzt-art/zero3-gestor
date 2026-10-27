import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
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
    '"Cliente Data Inválida",31/02/2026,"50,25"',
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
  const invalidDateRow = mapSalesImportRow(parsed.sheets[0], parsed.sheets[0].rows[1]);
  assert.equal(invalidDateRow.kind, "pending");
  assert.equal(invalidDateRow.errors.length, 1);
  assert.equal(invalidDateRow.preview.customerName, "Cliente Data Inválida");
  assert.equal(invalidDateRow.preview.totalCents, 5025);
  assert.equal(invalidDateRow.preview.saleDate, "31/02/2026");

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
  const workbook1904 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook1904, XLSX.utils.aoa_to_sheet([
    ["NOME", "INICIO", "VALOR"], ["Cliente 1904", serial1904, 10],
  ]), "1904");
  workbook1904.Workbook = { WBProps: { date1904: true } };
  const parsed1904 = await parseSalesSpreadsheet(XLSX.write(workbook1904, { type: "array", bookType: "xlsx" }), "1904.xlsx");
  assert.equal(parsed1904.sheets[0].date1904, true);
  assert.equal(mapSalesImportRow(parsed1904.sheets[0], parsed1904.sheets[0].rows[0]).value?.saleDate, "2026-10-05");
  assert.equal(parseImportDate("31/02/2026"), null);
  assert.equal(parseImportDate(46150), "2026-05-08");
  assert.equal(parseImportDate("46150"), "2026-05-08");
  await assert.rejects(
    parseSalesSpreadsheet(new ArrayBuffer(4), "arquivo.xls"),
    /Formato não suportado/,
  );
});

export const originalSalesFile = new URL("../../../../attached_assets/0_Clientes_Individuais_1792690299275.xlsx", import.meta.url);

test("reconciles all six original worksheets and inspects March rows 29 and 30 directly", {
  skip: !existsSync(originalSalesFile) || process.env.ZERO3_RUN_SOURCE_WORKBOOK_TEST !== "1",
}, async () => {
  const bytes = readFileSync(originalSalesFile);
  const original = XLSX.read(bytes, { type: "buffer", cellNF: true });
  const parsed = await parseSalesSpreadsheet(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "original.xlsx",
  );
  assert.equal(parsed.sheets.length, 6);
  const expected = [[23, 1, 0], [9, 0, 15], [25, 0, 6], [2, 0, 22], [11, 0, 13], [7, 0, 0]];
  let totalCents = 0;
  let oracleCents = 0;
  for (const [index, sheet] of parsed.sheets.entries()) {
    const results = sheet.rows.map((row) => mapSalesImportRow(sheet, row));
    assert.deepEqual(["ready", "pending", "auxiliary"].map((kind) => results.filter((row) => row.kind === kind).length), expected[index]);
    assert.equal(sheet.mapping.customerName, 1);
    assert.equal(sheet.mapping.saleDate, 5);
    assert.equal(sheet.mapping.totalAmount, 7);
    for (const result of results) if (result.value) totalCents += result.value.totalCents;
    const worksheet = original.Sheets[sheet.name];
    for (let row = 2; row <= 1000; row += 1) {
      if (worksheet[`B${row}`]?.v && worksheet[`F${row}`]?.v && typeof worksheet[`H${row}`]?.v === "number") {
        oracleCents += Math.round(Number(worksheet[`H${row}`].v) * 100);
      }
    }
  }
  assert.equal(totalCents, oracleCents, "preview sum equals independently read source B/F/H cells");
  const january = parsed.sheets[0];
  const pending = mapSalesImportRow(january, january.rows.find((row) => row.sourceRow === 7)!);
  assert.equal(pending.kind, "pending");
  assert.equal(pending.errors.length, 1);
  assert.match(pending.errors[0], /Nome do cliente ausente/);
  assert.equal(pending.preview.totalCents, 119700);
  assert.equal(pending.preview.saleDate, "2026-01-05");
  for (const row of [29, 30]) {
    const worksheet = original.Sheets["Março"];
    assert.equal(worksheet[`B${row}`]?.v, undefined);
    assert.equal(worksheet[`F${row}`]?.v, undefined);
    assert.equal(worksheet[`H${row}`]?.v, undefined);
    assert.deepEqual(Object.keys(worksheet).filter((address) => /^[A-Z]+\d+$/.test(address)
      && XLSX.utils.decode_cell(address).r === row - 1
      && String(worksheet[address].v ?? "").trim()).sort(), [`D${row}`, `E${row}`]);
    assert.equal(mapSalesImportRow(parsed.sheets[2], parsed.sheets[2].rows.find((source) => source.sourceRow === row)!).kind, "auxiliary");
  }
  const blank = parsed.sheets.reduce((sum, sheet) => sum + sheet.ignoredBlankRows, 0);
  assert.equal(blank, 5860);
  assert.equal(parsed.sheets.reduce((sum, sheet) => sum + sheet.ignoredHeaderRows, 0), 6);
  console.log(JSON.stringify({ originalWorkbook: { sheets: 6, physicalRows: 6000, contentRows: 140, ready: 77, pending: 1, auxiliary: 56, blank, headers: 6, totalCents } }));
});

test("recognizes repeated headers, reordered blocks, formulas, hidden rows and unique formatted dates", async () => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["Relatório"], [],
    ["NOME", "INICIO", "VALOR", "PLANO"],
    ["Cliente A", 46150, 10.01],
    ["", "", "", "Plano auxiliar"],
    ["NOME", "INICIO", "VALOR", "PLANO"],
    [],
    ["VALOR", "NOME", "Dia do contrato"],
    [25.05, "Cliente B", 46175],
    [null, "Cliente C", "2026-06-03"],
  ]);
  worksheet["C9"].z = "dd/mm/yyyy";
  worksheet["C4"] = { t: "n", f: "10+0.01", v: 10.01 };
  worksheet["A7"] = { t: "s", f: 'IF(1=1,"","x")', v: "" };
  worksheet["A10"] = { t: "n", f: "SUM(Z1:Z2)" }; // deliberately no cached result
  worksheet["!rows"] = Array.from({ length: 10 }, (_, index) => ({ hidden: index === 8 }));
  worksheet["!autofilter"] = { ref: "A8:C10" };
  XLSX.utils.book_append_sheet(workbook, worksheet, "Blocos");
  const parsed = await parseSalesSpreadsheet(XLSX.write(workbook, { type: "array", bookType: "xlsx" }), "blocos.xlsx");
  const sheet = parsed.sheets[0];
  assert.equal(sheet.blocks.length, 2);
  assert.equal(sheet.ignoredHeaderRows, 3);
  assert.equal(mapSalesImportRow(sheet, sheet.rows.find((row) => row.sourceRow === 4)!).value?.saleDate, "2026-05-08");
  assert.equal(mapSalesImportRow(sheet, sheet.rows.find((row) => row.sourceRow === 5)!).kind, "auxiliary");
  const hidden = sheet.rows.find((row) => row.sourceRow === 9)!;
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.inFilterRange, true);
  assert.equal(mapSalesImportRow(sheet, hidden).kind, "ready");
  assert.match(mapSalesImportRow(sheet, hidden).dateSource, /C9.*única data/);
  const formula = mapSalesImportRow(sheet, sheet.rows.find((row) => row.sourceRow === 10)!);
  assert.equal(formula.preview.customerName, "Cliente C");
  assert.equal(formula.preview.saleDate, "2026-06-03");
  assert.equal(formula.errors.length, 1);
  assert.match(formula.errors[0], /fórmula em A10 sem resultado/);
});

test("ambiguous dates require one block mapping and arbitrary numbers are not inferred as dates", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["NOME", "DATA", "DATA", "VALOR"], ["Cliente", "03/05/2026", "04/05/2026", 50],
  ]), "Ambígua");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["NOME", "Código", "VALOR"], ["Cliente", 46150, 50],
  ]), "Número");
  const parsed = await parseSalesSpreadsheet(XLSX.write(workbook, { type: "array", bookType: "xlsx" }), "ambiguo.xlsx");
  assert.equal(mapSalesImportRow(parsed.sheets[0], parsed.sheets[0].rows[0]).kind, "pending");
  parsed.sheets[0].mapping.saleDate = 1;
  assert.equal(mapSalesImportRow(parsed.sheets[0], parsed.sheets[0].rows[0]).value?.saleDate, "2026-05-03");
  assert.equal(mapSalesImportRow(parsed.sheets[1], parsed.sheets[1].rows[0]).kind, "pending");
  assert.equal(parsed.sheets[1].mapping.saleDate, null);
});
