import assert from "node:assert/strict";
import test from "node:test";
import type { Sale, SalesScoreboardProduct } from "@workspace/api-client-react";
import { buildSalesSectorGroups, classifySaleSector, classifySalesSector, sumSalesScoreboardProducts } from "./sales-channel-report";

function product(
  overrides: Partial<SalesScoreboardProduct> & Pick<SalesScoreboardProduct, "productId" | "productName">,
): SalesScoreboardProduct {
  return {
    modalityId: null,
    modalityName: null,
    saleCount: 0,
    quantity: 0,
    salesCents: 0,
    refundCents: 0,
    netCents: 0,
    ...overrides,
  };
}

function sale(overrides: Partial<Sale> & Pick<Sale, "productName">): Sale {
  return {
    id: "sale-test",
    productId: null,
    modalityId: null,
    modalityOverride: false,
    saleDate: "2026-10-27",
    productName: overrides.productName,
    quantity: 1,
    unitAmountCents: 100,
    totalCents: 100,
    customerName: null,
    notes: null,
    status: "active",
    cancellationReason: null,
    version: 1,
    createdAt: "2026-10-27T12:00:00.000Z",
    updatedAt: "2026-10-27T12:00:00.000Z",
    ...overrides,
  };
}

test("current product modality is the primary dynamic sector classification", () => {
  assert.deepEqual(
    classifySalesSector(product({
      productId: "wellhub",
      productName: "WellHub",
      modalityId: "in-person-id",
      modalityName: "Presencial",
    })),
    { key: "modality:in-person-id", label: "Presencial" },
  );
  assert.deepEqual(
    classifySalesSector(product({
      productId: "hyrox",
      productName: "Online: HYROX mensal",
      modalityId: "hyrox-id",
      modalityName: "HYROX",
    })),
    { key: "modality:hyrox-id", label: "HYROX" },
  );
});

test("name-prefix fallback is used only when no product modality is available", () => {
  assert.deepEqual(
    classifySalesSector(product({ productId: "legacy", productName: "ONLINE - Plano antigo" })),
    { key: "prefix:online", label: "Online" },
  );
  assert.equal(
    classifySalesSector(product({
      productId: "dangling",
      productName: "PRESENCIAL: Plano legado",
      modalityId: "missing-modality",
    })).key,
    "unclassified",
  );
});

test("sale fallback uses the current linked product name, not a stale sale snapshot", () => {
  assert.deepEqual(classifySaleSector(sale({
    productName: "Plano com nome antigo",
    effectiveProductName: "ONLINE · Plano atual",
    effectiveModalityId: null,
    effectiveModalityName: null,
    resolvedProductId: "product-current",
    productResolution: "linked-id",
  })), { key: "prefix:online", label: "Online" });
});

test("explicit sale-level unclassified choice remains unclassified despite a product prefix", () => {
  const classification = classifySaleSector(sale({
    productName: "PRESENCIAL: WELLHUB",
    modalityOverride: true,
    modalityId: null,
    effectiveModalityId: null,
    effectiveModalityName: null,
    resolvedProductId: "wellhub",
    productResolution: "linked-name",
  }));
  assert.equal(classification.key, "unclassified");
});

test("ambiguous legacy product names are never classified from a guessed link", () => {
  assert.equal(classifySaleSector(sale({
    productName: "WellHub",
    productResolution: "ambiguous-name",
  })).key, "unclassified");
});

test("sector subtotals partition sales and reconcile with the overall totals", () => {
  const products = [
    product({
      productId: "wellhub",
      productName: "WellHub",
      modalityId: "in-person-id",
      modalityName: "Presencial",
      saleCount: 2,
      quantity: 3,
      salesCents: 30_000,
      refundCents: 5_000,
      netCents: 25_000,
    }),
    product({
      productId: "online",
      productName: "Plano mensal",
      modalityId: "online-id",
      modalityName: "Online",
      saleCount: 1,
      quantity: 1,
      salesCents: 20_000,
      refundCents: 20_000,
      netCents: 0,
    }),
    product({
      productId: null,
      productName: "Venda não vinculada",
      saleCount: 1,
      quantity: 2,
      salesCents: 10_000,
      refundCents: 0,
      netCents: 10_000,
    }),
  ];
  const groups = buildSalesSectorGroups(products);
  const totals = sumSalesScoreboardProducts(products);

  assert.deepEqual(groups.map((group) => group.label), ["Online", "Presencial", "Outros / sem classificação"]);
  assert.equal(groups.flatMap((group) => group.products).length, products.length);
  assert.deepEqual(
    groups.reduce((sum, group) => ({
      saleCount: sum.saleCount + group.totals.saleCount,
      quantity: sum.quantity + group.totals.quantity,
      salesCents: sum.salesCents + group.totals.salesCents,
      refundCents: sum.refundCents + group.totals.refundCents,
      netCents: sum.netCents + group.totals.netCents,
    }), { saleCount: 0, quantity: 0, salesCents: 0, refundCents: 0, netCents: 0 }),
    totals,
  );
});
