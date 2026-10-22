export function normalizeProductName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function productNameKey(value: string): string {
  return normalizeProductName(value).toLocaleLowerCase("pt-BR");
}

export function formatCents(cents: number | bigint): string {
  const value = typeof cents === "bigint" ? cents : BigInt(Math.trunc(cents));
  const whole = value / 100n;
  const fraction = String(value % 100n).padStart(2, "0");
  return `R$\u00a0${whole.toLocaleString("pt-BR")},${fraction}`;
}

export function getSaoPauloMonthKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) {
    throw new Error("Unable to determine the current month in America/Sao_Paulo");
  }
  return `${year}-${month}`;
}

export function monthKeysBetween(first: string, last: string): string[] {
  const firstMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(first);
  const lastMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(last);
  if (!firstMatch || !lastMatch) return [];

  const firstIndex = Number(firstMatch[1]) * 12 + Number(firstMatch[2]) - 1;
  const lastIndex = Number(lastMatch[1]) * 12 + Number(lastMatch[2]) - 1;
  if (lastIndex < firstIndex) return [];

  return Array.from({ length: lastIndex - firstIndex + 1 }, (_, offset) => {
    const index = firstIndex + offset;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  });
}

export function formatMonthKey(monthKey: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return monthKey;
  return new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${monthKey}-01T00:00:00.000Z`));
}

function calendarDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth ? { year, month, day } : null;
}

export function isCompleteCalendarMonthRange(fromDate: string, toDate: string): boolean {
  const start = calendarDateParts(fromDate);
  const end = calendarDateParts(toDate);
  if (!start || !end || fromDate > toDate || start.day !== 1) return false;

  const leapYear = end.year % 4 === 0 && (end.year % 100 !== 0 || end.year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][end.month - 1];
  return end.day === daysInMonth;
}
