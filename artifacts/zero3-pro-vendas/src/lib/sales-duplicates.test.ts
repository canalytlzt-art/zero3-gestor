import assert from "node:assert/strict";
import test from "node:test";
import {
  findSalesImportDuplicateNotices,
  findPossibleSaleDuplicates,
  matchingSaleDuplicateFields,
  saleDuplicateFieldLabels,
} from "./sales-duplicates";

const sale = {
  customerName: "  ANA   SOUZA ",
  saleDate: "2026-10-27",
  productName: "Plano 12 aulas",
  totalCents: 60000,
};

test("normalizes case and extra spaces, then names all matching fields", () => {
  const fields = matchingSaleDuplicateFields(sale, {
    customerName: "Ana Souza",
    saleDate: "2026-10-27",
    productName: " plano 12 AULAS ",
    totalCents: 60000,
  });

  assert.deepEqual(fields, ["customerName", "saleDate", "productName", "totalCents"]);
  assert.deepEqual(fields.map((field) => saleDuplicateFieldLabels[field]), [
    "nome do cliente",
    "data",
    "produto/plano",
    "valor",
  ]);
});

test("flags a possible duplicate at three matching fields, without requiring all four", () => {
  const matches = findPossibleSaleDuplicates(sale, [{
    id: "existing-sale",
    customerName: "Ana Souza",
    saleDate: "2026-10-27",
    productName: "Plano 12 aulas",
    totalCents: 50000,
  }]);

  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].fields, ["customerName", "saleDate", "productName"]);
});

test("shows matching import rows and existing sales without using ignored lines as import matches", () => {
  const notices = findSalesImportDuplicateNotices([
    { key: "Vendas:2", label: "Planilha: Vendas, linha 2", included: true, ...sale },
    { key: "Vendas:3", label: "Planilha: Vendas, linha 3", included: true, ...sale },
    { key: "Vendas:4", label: "Planilha: Vendas, linha 4", included: false, ...sale },
  ], [{
    id: "existing-sale",
    ...sale,
    totalCents: 50000,
  }]);

  assert.equal(notices.get("Vendas:2")?.length, 2, "matches the existing record and the other included spreadsheet row");
  assert.deepEqual(notices.get("Vendas:2")?.map((notice) => notice.label), [
    "Venda já registrada",
    "Planilha: Vendas, linha 3",
  ]);
  assert.deepEqual(notices.get("Vendas:2")?.[0]?.fields, ["customerName", "saleDate", "productName"]);
  assert.ok(!notices.get("Vendas:2")?.some((notice) => notice.label.endsWith("linha 4")),
    "an explicitly ignored row is not treated as another sale being imported");
  assert.ok(notices.get("Vendas:4")?.some((notice) => notice.label.endsWith("linha 2")),
    "the ignored row keeps its warning so it can be restored with the explicit import action");
});

test("does not flag fewer than three matches or treat missing fields as matching", () => {
  const matches = findPossibleSaleDuplicates(sale, [
    { id: "two-matches", customerName: "Ana Souza", saleDate: "2026-10-27" },
    { id: "empty-fields", customerName: null, saleDate: "2026-10-27", productName: null, totalCents: null },
  ]);

  assert.deepEqual(matches, []);
});

test("can exclude the sale currently being edited", () => {
  const matches = findPossibleSaleDuplicates(
    sale,
    [{ id: "editing", ...sale }],
    { excludeId: "editing" },
  );

  assert.deepEqual(matches, []);
});
