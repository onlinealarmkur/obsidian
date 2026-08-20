import { describe, expect, it } from "vitest";
import {
  localDateTimeOccurrences,
  nextAlarmTimestamp,
  resumedTargetAt,
  timerRemainingMs,
  type DateTimeErrorCode,
  type DateTimeResult
} from "../src/utils/date-time";

const { execFileSync } = process.getBuiltinModule("child_process");

interface TimezoneInput {
  time: string;
  date?: string;
  now: string;
}

function runInTimezone(timezone: string, input: TimezoneInput): DateTimeResult {
  const moduleUrl = new URL("../src/utils/date-time.ts", import.meta.url).href;
  const script = `
    import { nextAlarmTimestamp } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.argv[1]);
    const result = nextAlarmTimestamp(input.time, input.date, new Date(input.now));
    process.stdout.write(JSON.stringify(result));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script, JSON.stringify(input)], {
    encoding: "utf8",
    env: { ...process.env, TZ: timezone },
    timeout: 5_000
  });
  const parsed: unknown = JSON.parse(output);
  if (parsed === null || typeof parsed !== "object") throw new TypeError("Timezone subprocess returned an invalid result.");
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record.timestamp === "number" ? { timestamp: record.timestamp } : {}),
    ...(isDateTimeErrorCode(record.error) ? { error: record.error } : {})
  };
}

function isDateTimeErrorCode(value: unknown): value is DateTimeErrorCode {
  return value === "invalid-time" || value === "invalid-date" || value === "future-required" || value === "occurrence-not-found";
}

describe("date and timer calculations", () => {
  it("chooses tomorrow when a time has passed", () => {
    const now = new Date(2026, 6, 14, 15, 0);
    const result = nextAlarmTimestamp("14:00", undefined, now);
    expect(new Date(result.timestamp ?? 0).getDate()).toBe(15);
  });

  it("chooses today for a future time", () => {
    const now = new Date(2026, 6, 14, 15, 0);
    expect(nextAlarmTimestamp("16:00", undefined, now).timestamp).toBe(new Date(2026, 6, 14, 16, 0).getTime());
  });

  it("rejects an explicit past date", () => {
    expect(nextAlarmTimestamp("12:00", "2026-07-13", new Date(2026, 6, 14, 15, 0)).error).toBe("future-required");
  });

  it("calculates pause and resume from absolute time", () => {
    expect(timerRemainingMs(20_000, 5_000)).toBe(15_000);
    expect(resumedTargetAt(15_000, 50_000)).toBe(65_000);
  });

  it.each([
    ["24:00", undefined, "invalid-time"],
    ["12:60", undefined, "invalid-time"],
    ["1:00", undefined, "invalid-time"],
    ["12:00 ", undefined, "invalid-time"],
    ["12:00", "2026-02-29", "invalid-date"],
    ["12:00", "2026-13-01", "invalid-date"],
    ["12:00", "2026-01-32", "invalid-date"],
    ["12:00", "26-01-01", "invalid-date"]
  ] as const)("rejects invalid wall-clock input %s / %s", (time, date, error) => {
    expect(nextAlarmTimestamp(time, date, new Date(2026, 0, 1))).toEqual({ error });
  });

  it("requires an explicit alarm occurrence to be strictly later than now", () => {
    const now = new Date(2028, 1, 29, 12, 0);
    expect(nextAlarmTimestamp("12:00", "2028-02-29", now)).toEqual({ error: "future-required" });
    expect(nextAlarmTimestamp("12:01", "2028-02-29", now).timestamp).toBe(new Date(2028, 1, 29, 12, 1).getTime());
  });

  it("rolls a date-less alarm across a year boundary", () => {
    const result = nextAlarmTimestamp("00:00", undefined, new Date(2026, 11, 31, 23, 59, 59));
    expect(result.timestamp).toBe(new Date(2027, 0, 1, 0, 0).getTime());
  });

  it("returns no occurrences for normalized-over invalid calendar fields", () => {
    expect(localDateTimeOccurrences({ year: 2026, month: 2, day: 29, hours: 12, minutes: 0 })).toEqual([]);
    expect(localDateTimeOccurrences({ year: 2026, month: 13, day: 1, hours: 12, minutes: 0 })).toEqual([]);
  });
});

describe("Europe/Madrid daylight-saving scheduling", () => {
  it("skips a nonexistent date-less spring time instead of normalizing it", () => {
    const result = runInTimezone("Europe/Madrid", {
      time: "02:30",
      now: "2026-03-28T23:30:00.000Z"
    });

    expect(new Date(result.timestamp ?? 0).toISOString()).toBe("2026-03-30T00:30:00.000Z");
  });

  it("rejects a nonexistent spring time with an explicit date", () => {
    const result = runInTimezone("Europe/Madrid", {
      time: "02:30",
      date: "2026-03-29",
      now: "2026-03-28T12:00:00.000Z"
    });

    expect(result).toEqual({ error: "invalid-date" });
  });

  it("chooses the later repeated fall occurrence after the earlier one passes", () => {
    const result = runInTimezone("Europe/Madrid", {
      time: "02:30",
      now: "2026-10-25T00:45:00.000Z"
    });

    expect(new Date(result.timestamp ?? 0).toISOString()).toBe("2026-10-25T01:30:00.000Z");
  });

  it("preserves ordinary local-time scheduling outside transitions", () => {
    const result = runInTimezone("Europe/Madrid", {
      time: "16:00",
      now: "2026-07-14T13:00:00.000Z"
    });

    expect(new Date(result.timestamp ?? 0).toISOString()).toBe("2026-07-14T14:00:00.000Z");
  });

  it("handles a half-hour daylight-saving gap", () => {
    const result = runInTimezone("Australia/Lord_Howe", {
      time: "02:15",
      date: "2026-10-04",
      now: "2026-10-03T00:00:00.000Z"
    });

    expect(result).toEqual({ error: "invalid-date" });
  });
});
