/**
 * Occupancy dates are calendar dates in America/Sao_Paulo, not instants.
 * Keep calculations on the stored YYYY-MM-DD parts so browser/Worker timezone
 * settings cannot move a class to the previous or following day.
 */
const WEEKDAYS = [
  { long: 'segunda-feira', short: 'Segunda' },
  { long: 'terça-feira', short: 'Terça' },
  { long: 'quarta-feira', short: 'Quarta' },
  { long: 'quinta-feira', short: 'Quinta' },
  { long: 'sexta-feira', short: 'Sexta' },
  { long: 'sábado', short: 'Sábado' },
  { long: 'domingo', short: 'Domingo' },
] as const;

export function getSaoPauloDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error('Unable to determine the current date in America/Sao_Paulo');
  }
  return `${year}-${month}-${day}`;
}

export function formatOccupancyPercentage(value: number): string {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1 || year > 9999
    || !Number.isInteger(month) || month < 1 || month > 12
    || !Number.isInteger(day) || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= daysInMonth;
}

export function getIsoWeekday(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return null;

  // setUTCFullYear avoids Date.UTC's special handling of years 00–99.
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  const weekday = calendarDate.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function getIsoWeekStart(date: string): string | null {
  const weekday = getIsoWeekday(date);
  if (weekday === null) return null;
  const [year, month, day] = date.split('-').map(Number);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day - weekday + 1);
  return calendarDate.toISOString().slice(0, 10);
}

export function getWeekdayName(date: string, style: 'long' | 'short' = 'long'): string | null {
  const weekday = getIsoWeekday(date);
  if (weekday === null) return null;
  const entry = WEEKDAYS[weekday - 1];
  return style === 'short' ? entry.short : entry.long;
}

export function getWeekdayNameForIsoDay(weekday: number): string {
  return WEEKDAYS[weekday - 1]?.short ?? String(weekday);
}
