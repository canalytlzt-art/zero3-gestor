import type { SalesScoreboardProduct } from "@workspace/api-client-react";

export type SalesChannelKey = "presencial" | "online" | "other";

export interface SalesChannelProductRow extends SalesScoreboardProduct {
  channel: SalesChannelKey;
  channelLabel: string;
  sportModalityName: string | null;
}

export interface SalesChannelTotals {
  saleCount: number;
  quantity: number;
  salesCents: number;
  refundCents: number;
  netCents: number;
}

export interface SalesChannelGroup {
  key: SalesChannelKey;
  label: string;
  products: SalesChannelProductRow[];
  totals: SalesChannelTotals;
}

const channelLabels: Record<SalesChannelKey, string> = {
  presencial: "Presencial",
  online: "Online",
  other: "Outros / Sem classificação",
};

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

function explicitChannel(value: string | null) {
  const normalized = normalize(value ?? "");
  if (["presencial", "presential", "in person"].includes(normalized)) return "presencial" as const;
  if (["online", "on-line", "digital"].includes(normalized)) return "online" as const;
  return null;
}

export function classifySalesChannel(product: Pick<SalesScoreboardProduct, "productName" | "modalityName">) {
  const storedChannel = explicitChannel(product.modalityName);
  if (storedChannel) return storedChannel;

  // Modality names such as CrossFit or HYROX describe the activity, not the sales channel.
  // When no explicit channel is stored, only a clear name prefix is used as a fallback.
  const prefix = normalize(product.productName).match(/^(presencial|online)(?:\s*:|\s*[|–—-]\s*|\s+)/);
  if (prefix?.[1] === "presencial") return "presencial" as const;
  if (prefix?.[1] === "online") return "online" as const;
  return "other" as const;
}

function zeroTotals(): SalesChannelTotals {
  return { saleCount: 0, quantity: 0, salesCents: 0, refundCents: 0, netCents: 0 };
}

export function buildSalesChannelGroups(products: SalesScoreboardProduct[]): SalesChannelGroup[] {
  const groups: SalesChannelGroup[] = [
    { key: "presencial", label: channelLabels.presencial, products: [], totals: zeroTotals() },
    { key: "online", label: channelLabels.online, products: [], totals: zeroTotals() },
    { key: "other", label: channelLabels.other, products: [], totals: zeroTotals() },
  ];
  const byKey = new Map(groups.map((group) => [group.key, group]));

  for (const product of products) {
    const channel = classifySalesChannel(product);
    const group = byKey.get(channel)!;
    group.products.push({
      ...product,
      channel,
      channelLabel: channelLabels[channel],
      sportModalityName: explicitChannel(product.modalityName) ? null : product.modalityName,
    });
    group.totals.saleCount += product.saleCount;
    group.totals.quantity += product.quantity;
    group.totals.salesCents += product.salesCents;
    group.totals.refundCents += product.refundCents;
    group.totals.netCents += product.netCents;
  }

  for (const group of groups) {
    group.products.sort((a, b) =>
      a.productName.localeCompare(b.productName, "pt-BR", { sensitivity: "base" })
      || (a.modalityName ?? "").localeCompare(b.modalityName ?? "", "pt-BR", { sensitivity: "base" }),
    );
  }
  return groups;
}

export function sumSalesScoreboardProducts(products: SalesScoreboardProduct[]): SalesChannelTotals {
  return products.reduce((total, product) => ({
    saleCount: total.saleCount + product.saleCount,
    quantity: total.quantity + product.quantity,
    salesCents: total.salesCents + product.salesCents,
    refundCents: total.refundCents + product.refundCents,
    netCents: total.netCents + product.netCents,
  }), zeroTotals());
}
