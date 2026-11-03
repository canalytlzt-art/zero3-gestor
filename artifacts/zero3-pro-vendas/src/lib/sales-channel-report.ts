import type { Sale, SalesScoreboardProduct } from "@workspace/api-client-react";

export interface SalesSectorProductRow extends SalesScoreboardProduct {
  sectorKey: string;
  sectorLabel: string;
}

export interface SalesSectorTotals {
  saleCount: number;
  quantity: number;
  salesCents: number;
  refundCents: number;
  netCents: number;
}

export interface SalesSectorGroup {
  key: string;
  label: string;
  products: SalesSectorProductRow[];
  totals: SalesSectorTotals;
}

const UNCLASSIFIED_KEY = "unclassified";
const UNCLASSIFIED_LABEL = "Outros / sem classificação";

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

function prefixSector(productName: string) {
  const prefix = normalize(productName).match(/^(presencial|online)(?:\s*:|\s*[|–—-]\s*|\s+)/);
  if (prefix?.[1] === "presencial") return { key: "prefix:presencial", label: "Presencial" };
  if (prefix?.[1] === "online") return { key: "prefix:online", label: "Online" };
  return null;
}

export function classifySalesSector(
  product: Pick<
    SalesScoreboardProduct,
    "productId" | "productName" | "modalityId" | "modalityName" | "explicitlyUnclassified"
  >,
) {
  if (product.explicitlyUnclassified) {
    return { key: UNCLASSIFIED_KEY, label: UNCLASSIFIED_LABEL };
  }
  if (product.modalityName?.trim()) {
    return {
      key: product.modalityId
        ? `modality:${product.modalityId}`
        : `modality-name:${normalize(product.modalityName)}`,
      label: product.modalityName.trim(),
    };
  }
  // A dangling modality ID is not a trustworthy reason to infer a different sector.
  if (product.modalityId) return { key: UNCLASSIFIED_KEY, label: UNCLASSIFIED_LABEL };
  const fallback = prefixSector(product.productName);
  return fallback ?? { key: UNCLASSIFIED_KEY, label: UNCLASSIFIED_LABEL };
}

export function classifySaleSector(sale: Sale) {
  const effectiveModalityId = sale.effectiveModalityId
    ?? (sale.modalityOverride ? sale.modalityId : null);
  const explicitlyUnclassified = sale.modalityOverride && !effectiveModalityId;
  if (sale.productResolution === "ambiguous-name" || sale.productResolution === "missing-product") {
    return { key: UNCLASSIFIED_KEY, label: UNCLASSIFIED_LABEL };
  }
  return classifySalesSector({
    productId: sale.resolvedProductId ?? sale.productId,
    productName: sale.effectiveProductName ?? sale.productName,
    modalityId: effectiveModalityId,
    modalityName: sale.effectiveModalityName ?? null,
    explicitlyUnclassified,
  });
}

function zeroTotals(): SalesSectorTotals {
  return { saleCount: 0, quantity: 0, salesCents: 0, refundCents: 0, netCents: 0 };
}

export function buildSalesSectorGroups(products: SalesScoreboardProduct[]): SalesSectorGroup[] {
  const byKey = new Map<string, SalesSectorGroup>();
  for (const product of products) {
    const sector = classifySalesSector(product);
    let group = byKey.get(sector.key);
    if (!group) {
      group = { key: sector.key, label: sector.label, products: [], totals: zeroTotals() };
      byKey.set(sector.key, group);
    }
    group.products.push({ ...product, sectorKey: sector.key, sectorLabel: sector.label });
    group.totals.saleCount += product.saleCount;
    group.totals.quantity += product.quantity;
    group.totals.salesCents += product.salesCents;
    group.totals.refundCents += product.refundCents;
    group.totals.netCents += product.netCents;
  }
  return [...byKey.values()]
    .map((group) => ({
      ...group,
      products: group.products.sort((a, b) =>
        a.productName.localeCompare(b.productName, "pt-BR", { sensitivity: "base" })
        || (a.productId ?? "").localeCompare(b.productId ?? ""),
      ),
    }))
    .sort((a, b) => {
      if (a.key === UNCLASSIFIED_KEY) return 1;
      if (b.key === UNCLASSIFIED_KEY) return -1;
      return a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base" });
    });
}

export function sumSalesScoreboardProducts(products: SalesScoreboardProduct[]): SalesSectorTotals {
  return products.reduce((total, product) => ({
    saleCount: total.saleCount + product.saleCount,
    quantity: total.quantity + product.quantity,
    salesCents: total.salesCents + product.salesCents,
    refundCents: total.refundCents + product.refundCents,
    netCents: total.netCents + product.netCents,
  }), zeroTotals());
}
