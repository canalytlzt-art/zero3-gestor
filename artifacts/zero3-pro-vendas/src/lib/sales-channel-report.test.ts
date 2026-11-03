import assert from "node:assert/strict";
import test from "node:test";
import type { SalesScoreboardProduct } from "@workspace/api-client-react";
import { buildSalesChannelGroups, classifySalesChannel, sumSalesScoreboardProducts } from "./sales-channel-report";

function product(overrides: Partial<SalesScoreboardProduct> & Pick<SalesScoreboardProduct, "productId" | "productName">): SalesScoreboardProduct {
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

test("prefers explicit channel labels and uses clear product prefixes only as fallback", () => {
  assert.equal(classifySalesChannel(product({
    productId: "a",
    productName: "Plano sem prefixo",
    modalityName: " Online ",
  })), "online");
  assert.equal(classifySalesChannel(product({
    productId: "b",
    productName: "online: CrossFit mensal",
    modalityName: "CrossFit",
  })), "online");
  assert.equal(classifySalesChannel(product({
    productId: "c",
    productName: "PRESENCIAL – Aula avulsa",
    modalityName: null,
  })), "presencial");
});

test("does not infer the sales channel from sport modalities or third-party product names", () => {
  assert.equal(classifySalesChannel(product({
    productId: "a",
    productName: "CrossFit Competition Mensal",
    modalityName: "CrossFit",
  })), "other");
  assert.equal(classifySalesChannel(product({
    productId: "b",
    productName: "Wellhub",
    modalityName: "CrossFit",
  })), "other");
});

test("channel subtotals partition product sales exactly once and reconcile financial totals", () => {
  const products = [
    product({
      productId: "in-person",
      productName: "PRESENCIAL: CrossFit mensal",
      modalityName: "CrossFit",
      saleCount: 2,
      quantity: 3,
      salesCents: 30_000,
      refundCents: 5_000,
      netCents: 25_000,
    }),
    product({
      productId: "online",
      productName: "Competition anual",
      modalityName: "Online",
      saleCount: 1,
      quantity: 1,
      salesCents: 20_000,
      refundCents: 20_000,
      netCents: 0,
    }),
    product({
      productId: "third-party",
      productName: "TotalPass",
      modalityName: "HYROX",
      saleCount: 1,
      quantity: 2,
      salesCents: 10_000,
      refundCents: 0,
      netCents: 10_000,
    }),
  ];
  const groups = buildSalesChannelGroups(products);
  const totals = sumSalesScoreboardProducts(products);

  assert.deepEqual(groups.map((group) => group.key), ["presencial", "online", "other"]);
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
  assert.equal(groups[2]?.products[0]?.sportModalityName, "HYROX");
});
