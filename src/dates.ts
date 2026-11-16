// 날짜 머리말이 없을 때 라이브러리가 0001-01-01이나 1970-01-01을 주는 경우가 있어, 그보다 이른 값은 모르는 날짜로 본다.
const EARLIEST_KNOWN_YEAR = 1980;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

export function knownDate(raw: string | Date | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime()) || value.getUTCFullYear() < EARLIEST_KNOWN_YEAR) return undefined;
  return value;
}

/** 사용자 PC 시간대의 ISO 형식(예: 2026-11-16T15:00:00+09:00). */
export function toLocalIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offsetMinutes * MS_PER_MINUTE);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offsetMinutes) / MINUTES_PER_HOUR)).padStart(2, '0');
  const minutes = String(Math.abs(offsetMinutes) % MINUTES_PER_HOUR).padStart(2, '0');
  return `${local.toISOString().slice(0, 19)}${sign}${hours}:${minutes}`;
}

/** 답장 인용에 쓰는 사람이 읽기 쉬운 형식(예: 2026-10-23 18:14 (UTC+09:00)). */
export function toLocalDisplay(date: Date): string {
  const iso = toLocalIso(date);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} (UTC${iso.slice(19)})`;
}

/** YYYY-MM-DD가 실제로 있는 날짜면 그날 0시(사용자 PC 시간대)를 돌려준다. */
export function parseDay(text: string): Date | undefined {
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const exists = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return exists ? date : undefined;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
