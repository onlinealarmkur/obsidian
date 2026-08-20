import { MAX_DURATION_MS } from "../constants";

export interface DurationParseResult {
  milliseconds?: number;
  error?: DurationErrorCode;
}

export type DurationErrorCode = "required" | "invalid-format" | "minimum" | "maximum";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export function parseDuration(input: string): DurationParseResult {
  const value = input.trim().toLowerCase();
  if (value.length === 0) return { error: "required" };

  let milliseconds: number | undefined;
  if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(value)) {
    const parts = value.split(":").map(Number);
    if (parts.length === 2) {
      const [minutes, seconds] = parts;
      if (minutes !== undefined && seconds !== undefined && seconds < 60) {
        milliseconds = (minutes * 60 + seconds) * SECOND_MS;
      }
    } else {
      const [hours, minutes, seconds] = parts;
      if (hours !== undefined && minutes !== undefined && seconds !== undefined && minutes < 60 && seconds < 60) {
        milliseconds = (hours * 3600 + minutes * 60 + seconds) * SECOND_MS;
      }
    }
  } else {
    const pattern = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/;
    const match = pattern.exec(value);
    if (match !== null) {
      milliseconds = (Number(match[1] ?? 0) * HOUR_MS) + (Number(match[2] ?? 0) * MINUTE_MS) + (Number(match[3] ?? 0) * SECOND_MS);
    }
  }

  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return { error: "invalid-format" };
  }
  if (milliseconds < SECOND_MS) return { error: "minimum" };
  if (milliseconds > MAX_DURATION_MS) return { error: "maximum" };
  return { milliseconds };
}
