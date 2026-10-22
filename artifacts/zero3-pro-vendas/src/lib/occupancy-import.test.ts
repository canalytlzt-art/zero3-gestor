import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { parseOccupancySpreadsheet } from "./occupancy-import";

function workbookBytes(sheets: Record<string, XLSX.WorkSheet>, date1904 = false, hiddenSheets: string[] = []): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, sheet] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, sheet, name);
  workbook.Workbook = {
    ...(workbook.Workbook ?? {}),
    WBProps: { date1904 },
    Sheets: workbook.SheetNames.map((name) => ({ name, Hidden: hiddenSheets.includes(name) ? 1 : 0 })),
  };
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array", cellStyles: true });
  const bytes = new Uint8Array(output);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function rows(...data: unknown[][]) {
  return XLSX.utils.aoa_to_sheet(data);
}

test("reads row-per-date data and retains original source addresses", async () => {
  const sheet = rows(
    ["Data da aula", "Modalidade", "% ocupação", "Turma"],
    ["05/10/2026", "Pilates", 75, "18h"],
  );
  const result = await parseOccupancySpreadsheet(workbookBytes({ "Dados 2026": sheet }), "aulas.xlsx");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].status, "ready");
  assert.equal(result.entries[0].period, "2026-10-05");
  assert.equal(result.entries[0].percentage, 75);
  assert.equal(result.entries[0].sourceCell, "C2");
  assert.deepEqual(result.entries[0].sourceCells, { period: "A2", modality: "B2", percentage: "C2", class: "D2" });
});

test("reads modality-by-month matrices and carries years from month headings", async () => {
  const sheet = rows(
    ["Modalidade", "Turma", "Jan 2026", "Fev 2026"],
    ["Pilates", "Noite", 70, 0],
  );
  const result = await parseOccupancySpreadsheet(workbookBytes({ Mensal: sheet }), "ocupacao.xlsx");
  assert.deepEqual(result.entries.map(({ period, percentage, status }) => ({ period, percentage, status })), [
    { period: "2026-01", percentage: 70, status: "ready" },
    { period: "2026-02", percentage: 0, status: "ready" },
  ]);
  assert.equal(result.entries[0].sourceCell, "C2");
});

test("reads date-by-modality matrices and month-per-modality records", async () => {
  const daily = rows(["Data", "Pilates", "Yoga"], ["2026-10-01", 60, 80]);
  const monthly = rows(["Mês/ano", "Modalidade", "Ocupação"], ["10/2026", "Pilates", 75]);
  const result = await parseOccupancySpreadsheet(workbookBytes({ Diário: daily, "Por mês": monthly }), "ocupacao.xlsx");
  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.entries.map((entry) => entry.status), ["ready", "ready", "ready"]);
  assert.deepEqual(result.entries.map((entry) => entry.kind), ["daily", "daily", "monthly"]);
  assert.equal(result.entries[1].modalityName, "Yoga");
  assert.equal(result.entries[1].sourceCell, "C2");
});

test("resolves missing years once and requires explicit scale for ambiguous General values", async () => {
  const sheet = rows(["Mês", "Modalidade", "Ocupação"], ["Mar", "Pilates", 0.75]);
  const bytes = workbookBytes({ Dados: sheet });
  const first = await parseOccupancySpreadsheet(bytes, "sem-ano.xlsx");
  assert.equal(first.missingYear, true);
  assert.equal(first.entries[0].status, "pending");
  assert.ok(first.scaleDecisions.length > 0);

  const fractional = await parseOccupancySpreadsheet(bytes, "sem-ano.xlsx", { missingYear: 2026, scaleDecisions: { [first.scaleDecisions[0].key]: "fraction" } });
  assert.equal(fractional.entries[0].period, "2026-03");
  assert.equal(fractional.entries[0].percentage, 75);
  assert.equal(fractional.entries[0].status, "ready");

  const percent = await parseOccupancySpreadsheet(bytes, "sem-ano.xlsx", { missingYear: 2026, scaleDecisions: { [first.scaleDecisions[0].key]: "percent" } });
  assert.equal(percent.entries[0].percentage, 0.75);
});

test("uses block-level 0–100 scale, explicit percentage text, and Excel percent formatting", async () => {
  const sheet = rows(["Data", "Modalidade", "Ocupação"], ["2026-10-01", "A", 0.75], ["2026-10-02", "B", 75], ["2026-10-03", "C", "75%"]);
  sheet.C2!.z = "0.00%";
  const result = await parseOccupancySpreadsheet(workbookBytes({ Dados: sheet }), "percentuais.xlsx");
  assert.deepEqual(result.entries.map((entry) => entry.percentage), [75, 75, 75]);
  assert.equal(result.scaleDecisions.length, 0);
  assert.ok(result.entries.every((entry) => entry.status === "ready"));
});

test("does not silently accept invalid percentages, formula errors, or formulas without cached results", async () => {
  const sheet = rows(["Data", "Modalidade", "Ocupação"], ["2026-10-01", "A", 150], ["2026-10-02", "B", 50], ["2026-10-03", "C", 75]);
  sheet.C3 = { t: "e", v: 7, w: "#DIV/0!", f: "1/0" };
  sheet.C4 = { t: "n", f: "SUM(1,2)" };
  const result = await parseOccupancySpreadsheet(workbookBytes({ Dados: sheet }), "formulas.xlsx");
  assert.ok(result.entries.every((entry) => entry.status === "pending"));
  assert.match(result.entries[0].reason, /fora de 0% a 100%/);
  assert.match(result.entries[1].reason, /Erro de fórmula/);
  assert.match(result.entries[2].reason, /sem resultado calculado/);
});

test("skips repeated headers and totals but reports data under an unrecognized header as pending", async () => {
  const sheet = rows(
    ["Data", "Modalidade", "Ocupação"],
    ["2026-10-01", "A", 50],
    ["Data", "Modalidade", "Ocupação"],
    ["Total", "", 50],
    ["2026-10-02", "B", 60],
  );
  const result = await parseOccupancySpreadsheet(workbookBytes({ Dados: sheet }), "repetido.xlsx");
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries.map((entry) => entry.status), ["ready", "ready"]);
  assert.ok(result.ignoredCount >= 2);

  const unknown = await parseOccupancySpreadsheet(workbookBytes({ Dados: rows(["Dia", "Mod", "Lotação"], ["2026-10-01", "A", 50]) }), "desconhecido.xlsx");
  assert.equal(unknown.entries[0].status, "pending");
  assert.match(unknown.entries[0].reason, /Cabeçalho não identificado|inválido/);
});

test("marks duplicate scopes and mixed daily/monthly representations for review", async () => {
  const sameSheet = rows(["Data", "Modalidade", "Ocupação"], ["2026-10-01", "A", 50], ["2026-10-01", "A", 60]);
  const result = await parseOccupancySpreadsheet(workbookBytes({ Dados: sameSheet }), "duplicados.xlsx");
  assert.equal(result.entries[1].status, "ready");
  assert.ok(result.entries[0].overlapKey);
  assert.equal(result.entries[0].overlapKey, result.entries[1].overlapKey);

  const mixed = await parseOccupancySpreadsheet(workbookBytes({
    Diário: rows(["Data", "Modalidade", "Ocupação"], ["2026-10-01", "A", 50]),
    Mensal: rows(["Mês/ano", "Modalidade", "Ocupação"], ["10/2026", "A", 60]),
  }), "misturado.xlsx");
  assert.ok(mixed.entries.every((entry) => entry.overlapKey));
});

test("reads Excel date serials in both date systems and avoids expanding styled-only ranges", async () => {
  const date1900 = await parseOccupancySpreadsheet(workbookBytes({
    Dados: rows(["Data", "Modalidade", "Ocupação"], [46300, "A", 50]),
  }), "1900.xlsx");
  assert.equal(date1900.entries[0].period, "2026-10-05");

  const date1904 = await parseOccupancySpreadsheet(workbookBytes({
    Dados: rows(["Data", "Modalidade", "Ocupação"], [44838, "A", 50]),
  }, true), "1904.xlsx");
  assert.equal(date1904.entries[0].period, "2026-10-05");

  const sparse = rows(["Data", "Modalidade", "Ocupação"], ["2026-10-01", "A", 50]);
  sparse["!ref"] = "A1:Z1000";
  const start = Date.now();
  const sparseResult = await parseOccupancySpreadsheet(workbookBytes({ Dados: sparse }), "estilizada.xlsx");
  assert.equal(sparseResult.entries.length, 1);
  assert.ok(Date.now() - start < 5000);
});

test("decodes legacy CSV accents and imports every worksheet without touching hidden-sheet defaults", async () => {
  const cp1252 = Uint8Array.from([0x44, 0x61, 0x74, 0x61, 0x2c, 0x4d, 0x6f, 0x64, 0x61, 0x6c, 0x69, 0x64, 0x61, 0x64, 0x65, 0x2c, 0x4f, 0x63, 0x75, 0x70, 0x61, 0xe7, 0xe3, 0x6f, 0x0a, 0x32, 0x30, 0x32, 0x36, 0x2d, 0x31, 0x30, 0x2d, 0x30, 0x31, 0x2c, 0x50, 0x69, 0x6c, 0x61, 0x74, 0x65, 0x73, 0x2c, 0x37, 0x35]);
  const csv = await parseOccupancySpreadsheet(cp1252.buffer.slice(cp1252.byteOffset, cp1252.byteOffset + cp1252.byteLength) as ArrayBuffer, "aulas.csv");
  assert.equal(csv.entries[0].percentage, 75);
  assert.equal(csv.entries[0].status, "ready");

  const bytes = workbookBytes({
    Visível: rows(["Data", "Modalidade", "Ocupação"], ["2026-10-01", "A", 40]),
    Oculta: rows(["Data", "Modalidade", "Ocupação"], ["2026-10-02", "B", 60]),
  }, false, ["Oculta"]);
  const allSheets = await parseOccupancySpreadsheet(bytes, "abas.xlsx");
  assert.equal(allSheets.entries.length, 2);
  assert.equal(allSheets.sheets.find((sheet) => sheet.name === "Oculta")?.hidden, true);
  assert.equal(allSheets.sheets.find((sheet) => sheet.name === "Oculta")?.selected, false);
});
