import assert from "node:assert/strict";
import test from "node:test";
import {
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
