import type { ActiveContractsMonth } from '@workspace/api-client-react';

export interface ActiveContractPeriodRow {
  month: string;
  record: ActiveContractsMonth | null;
  difference: number | null;
  attainment: number | null;
  changeFromPrevious: number | null;
}

/**
 * Builds period rows without treating missing monthly balances as zero.
 * Contract counts are snapshots, so each month remains an independent value.
 */
export function buildActiveContractPeriodRows(
  months: readonly string[],
  records: readonly ActiveContractsMonth[],
): ActiveContractPeriodRow[] {
  const recordsByMonth = new Map(records.map((record) => [record.month, record]));
  const chronologicalRecords = [...records].sort((left, right) => left.month.localeCompare(right.month));

  return months.map((month) => {
    const record = recordsByMonth.get(month) ?? null;
    if (!record) {
      return { month, record: null, difference: null, attainment: null, changeFromPrevious: null };
    }

    const previous = chronologicalRecords.filter((item) => item.month < month).at(-1) ?? null;
    return {
      month,
      record,
      difference: record.targetCount == null ? null : record.activeCount - record.targetCount,
      attainment: record.targetCount != null && record.targetCount > 0
        ? record.activeCount / record.targetCount * 100
        : null,
      changeFromPrevious: previous ? record.activeCount - previous.activeCount : null,
    };
  });
}
