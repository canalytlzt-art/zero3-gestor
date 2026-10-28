export type SaleDuplicateField = "customerName" | "saleDate" | "productName" | "totalCents";

export type SaleDuplicateCandidate = {
  customerName?: string | null;
  saleDate?: string | null;
  productName?: string | null;
  totalCents?: number | null;
};

export type SaleDuplicateRecord = SaleDuplicateCandidate & {
  id?: string;
  duplicateLabel?: string;
};

export type SaleDuplicateMatch = {
  record: SaleDuplicateRecord;
  fields: SaleDuplicateField[];
};

export const saleDuplicateFieldLabels: Record<SaleDuplicateField, string> = {
  customerName: "nome do cliente",
  saleDate: "data",
  productName: "produto/plano",
  totalCents: "valor",
};

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
  return normalized || null;
}

function normalizeDate(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const date = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function normalizeCents(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function matchingSaleDuplicateFields(
  left: SaleDuplicateCandidate,
  right: SaleDuplicateCandidate,
): SaleDuplicateField[] {
  const fields: SaleDuplicateField[] = [];
  const leftCustomer = normalizeText(left.customerName);
  const rightCustomer = normalizeText(right.customerName);
  if (leftCustomer && rightCustomer && leftCustomer === rightCustomer) fields.push("customerName");

  const leftDate = normalizeDate(left.saleDate);
  const rightDate = normalizeDate(right.saleDate);
  if (leftDate && rightDate && leftDate === rightDate) fields.push("saleDate");

  const leftProduct = normalizeText(left.productName);
  const rightProduct = normalizeText(right.productName);
  if (leftProduct && rightProduct && leftProduct === rightProduct) fields.push("productName");

  const leftCents = normalizeCents(left.totalCents);
  const rightCents = normalizeCents(right.totalCents);
  if (leftCents !== null && rightCents !== null && leftCents === rightCents) fields.push("totalCents");

  return fields;
}

export function findPossibleSaleDuplicates(
  candidate: SaleDuplicateCandidate,
  records: readonly SaleDuplicateRecord[],
  options: { excludeId?: string; minimumMatches?: number } = {},
): SaleDuplicateMatch[] {
  const minimumMatches = options.minimumMatches ?? 3;
  return records.flatMap((record) => {
    if (options.excludeId && record.id === options.excludeId) return [];
    const fields = matchingSaleDuplicateFields(candidate, record);
    return fields.length >= minimumMatches ? [{ record, fields }] : [];
  });
}
