export interface DateTimeResult {
  timestamp?: number;
  error?: DateTimeErrorCode;
}

export type DateTimeErrorCode = "invalid-time" | "invalid-date" | "future-required" | "occurrence-not-found";

export interface LocalDateTimeFields {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
}

const OFFSET_WINDOW_MS = 36 * 60 * 60 * 1_000;
const OFFSET_SAMPLE_STEP_MS = 30 * 60 * 1_000;
const NEXT_OCCURRENCE_SEARCH_DAYS = 8;

export function localDateTimeOccurrences(fields: LocalDateTimeFields): number[] {
  const wallClock = new Date(0);
  wallClock.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  wallClock.setUTCHours(fields.hours, fields.minutes, 0, 0);
  const wallClockTimestamp = wallClock.getTime();
  if (!Number.isFinite(wallClockTimestamp)) return [];

  const offsets = new Set<number>();
  for (
    let probe = wallClockTimestamp - OFFSET_WINDOW_MS;
    probe <= wallClockTimestamp + OFFSET_WINDOW_MS;
    probe += OFFSET_SAMPLE_STEP_MS
  ) {
    offsets.add(new Date(probe).getTimezoneOffset());
  }

  const occurrences = new Set<number>();
  for (const offset of offsets) {
    const timestamp = wallClockTimestamp + offset * 60_000;
    const candidate = new Date(timestamp);
    if (
      candidate.getFullYear() === fields.year
      && candidate.getMonth() === fields.month - 1
      && candidate.getDate() === fields.day
      && candidate.getHours() === fields.hours
      && candidate.getMinutes() === fields.minutes
      && candidate.getSeconds() === 0
      && candidate.getMilliseconds() === 0
    ) {
      occurrences.add(timestamp);
    }
  }
  return [...occurrences].sort((left, right) => left - right);
}

export function nextAlarmTimestamp(time: string, date: string | undefined, now = new Date()): DateTimeResult {
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (timeMatch === null) return { error: "invalid-time" };
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  if (hours > 23 || minutes > 59) return { error: "invalid-time" };

  if (date !== undefined && date.length > 0) {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (dateMatch === null) return { error: "invalid-date" };
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const occurrences = localDateTimeOccurrences({ year, month, day, hours, minutes });
    if (occurrences.length === 0) return { error: "invalid-date" };
    const futureOccurrence = occurrences.find((timestamp) => timestamp > now.getTime());
    if (futureOccurrence === undefined) return { error: "future-required" };
    return { timestamp: futureOccurrence };
  }

  const calendarDay = new Date(0);
  calendarDay.setUTCFullYear(now.getFullYear(), now.getMonth(), now.getDate());
  calendarDay.setUTCHours(0, 0, 0, 0);
  for (let dayOffset = 0; dayOffset < NEXT_OCCURRENCE_SEARCH_DAYS; ++dayOffset) {
    const candidateDay = new Date(calendarDay);
    candidateDay.setUTCDate(candidateDay.getUTCDate() + dayOffset);
    const occurrences = localDateTimeOccurrences({
      year: candidateDay.getUTCFullYear(),
      month: candidateDay.getUTCMonth() + 1,
      day: candidateDay.getUTCDate(),
      hours,
      minutes
    });
    const futureOccurrence = occurrences.find((timestamp) => timestamp > now.getTime());
    if (futureOccurrence !== undefined) return { timestamp: futureOccurrence };
  }
  return { error: "occurrence-not-found" };
}

export function timerRemainingMs(targetAt: number, now: number): number {
  return Math.max(0, targetAt - now);
}

export function resumedTargetAt(remainingMs: number, now: number): number {
  return now + Math.max(0, remainingMs);
}
