import { describe, expect, expectTypeOf, it } from "vitest";
import { InvalidSchemaVersionError, migrateData, UnsupportedSchemaVersionError } from "../src/data/migrations";
import { validateData } from "../src/data/validation";
import { MAX_DURATION_MS, MAX_LABEL_LENGTH } from "../src/constants";
import { DEFAULT_SETTINGS, type TimerItem } from "../src/types";
import { parseDuration } from "../src/utils/duration-parser";

describe("stored data", () => {
  it("models paused and non-paused timers as distinct variants", () => {
    type PausedTimer = Extract<TimerItem, { status: "paused" }>;
    type NonPausedTimer = Exclude<TimerItem, { status: "paused" }>;
    const paused: PausedTimer = {
      id: "typed-paused",
      type: "timer",
      label: "Typed",
      createdAt: 1,
      targetAt: 2,
      status: "paused",
      durationMs: 10_000,
      remainingMs: 5_000
    };
    expectTypeOf<PausedTimer["remainingMs"]>().toEqualTypeOf<number>();
    expectTypeOf<NonPausedTimer["remainingMs"]>().toEqualTypeOf<undefined>();
    expect(paused.remainingMs).toBe(5_000);
  });

  it.each([
    ["an absent version", { settings: { volume: 25 }, items: [] }, 25],
    ["a supported integer version", { schemaVersion: 2, settings: { volume: 25 }, items: [] }, 25]
  ])("accepts %s", (_description, raw, expectedVolume) => {
    const migrated = validateData(migrateData(raw));

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.settings.volume).toBe(expectedVolume);
  });

  it.each([
    ["a fractional future version", 1.5, "fractional", "number"],
    ["a negative version", -1, "negative", "number"],
    ["positive infinity", Number.POSITIVE_INFINITY, "non-finite", "number"],
    ["NaN", Number.NaN, "non-finite", "number"],
    ["a present non-number version", "1", "wrong-type", "string"]
  ] as const)("rejects %s with a typed metadata-only error", (_description, schemaVersion, classification, storedType) => {
    const raw = { schemaVersion, privateData: { retained: true } };
    let thrown: unknown;
    try {
      migrateData(raw);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidSchemaVersionError);
    if (!(thrown instanceof InvalidSchemaVersionError)) throw new Error("Expected an invalid schema error.");
    expect(thrown.classification).toBe(classification);
    expect(thrown.storedVersion).toBe(storedType === "number" ? schemaVersion : undefined);
    expect(thrown.storedType).toBe(storedType === "number" ? undefined : storedType);
    expect(thrown.message).not.toContain("privateData");
    expect(raw).toEqual({ schemaVersion, privateData: { retained: true } });
  });

  it("rejects a future integer schema with a typed version-only error", () => {
    let thrown: unknown;
    try {
      migrateData({ schemaVersion: 3, futureOnly: { privateData: true } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedSchemaVersionError);
    if (!(thrown instanceof UnsupportedSchemaVersionError)) throw new Error("Expected an unsupported schema error.");
    expect(thrown.storedVersion).toBe(3);
    expect(thrown.supportedVersion).toBe(2);
    expect(thrown.message).not.toContain("privateData");
  });

  it("repairs settings and discards malformed items", () => {
    const data = validateData({ schemaVersion: 1, settings: { volume: 900 }, items: [{ type: "alarm" }] });
    expect(data.settings.volume).toBe(100);
    expect(data.items).toEqual([]);
  });

  it("repairs non-finite, wrong-type, and out-of-range scalar settings", () => {
    const data = validateData({
      settings: {
        defaultTimerMinutes: Number.NaN,
        use24HourTime: "true",
        showStatusBar: null,
        enableSound: 1,
        volume: Number.NEGATIVE_INFINITY,
        enableSystemNotifications: "yes",
        overdueGraceMinutes: 100_000
      },
      items: []
    });

    expect(data.settings).toMatchObject({
      defaultTimerMinutes: DEFAULT_SETTINGS.defaultTimerMinutes,
      use24HourTime: DEFAULT_SETTINGS.use24HourTime,
      showStatusBar: DEFAULT_SETTINGS.showStatusBar,
      enableSound: DEFAULT_SETTINGS.enableSound,
      volume: DEFAULT_SETTINGS.volume,
      enableSystemNotifications: false,
      overdueGraceMinutes: 1_440
    });
  });

  it("preserves labels at the maximum length and truncates longer labels", () => {
    const maximumLabel = "a".repeat(MAX_LABEL_LENGTH);
    const overlongLabel = `${maximumLabel}b`;
    const alarm = (id: string, label: string) => ({
      id,
      type: "alarm",
      label,
      createdAt: 1,
      targetAt: 20,
      status: "active",
    });

    const data = validateData({ settings: {}, items: [alarm("maximum", maximumLabel), alarm("overlong", overlongLabel)] });

    expect(overlongLabel).toHaveLength(MAX_LABEL_LENGTH + 1);
    expect(data.items[0]?.label).toBe(maximumLabel);
    expect(data.items[1]?.label).toBe(maximumLabel);
    expect(data.items[1]?.label).toHaveLength(MAX_LABEL_LENGTH);
  });

  it("rounds a fractional legacy timer default to a parseable whole minute", () => {
    const data = validateData({ settings: { defaultTimerMinutes: 1.5 }, items: [] });

    expect(data.settings.defaultTimerMinutes).toBe(2);
    expect(parseDuration(`${data.settings.defaultTimerMinutes}m`).milliseconds).toBe(120_000);
    expect(validateData({ settings: { defaultTimerMinutes: 0.4 }, items: [] }).settings.defaultTimerMinutes).toBe(1);
    expect(validateData({ settings: { defaultTimerMinutes: 43_200.6 }, items: [] }).settings.defaultTimerMinutes).toBe(43_200);
  });

  it("rounds a fractional stored overdue grace period to a whole minute", () => {
    const data = validateData({ settings: { overdueGraceMinutes: 1.5 }, items: [] });

    expect(data.settings.overdueGraceMinutes).toBe(2);
  });

  it("migrates schema-1 fired history to completed without replaying it", () => {
    const data = validateData(migrateData({
      schemaVersion: 1,
      settings: {},
      items: [{
        id: "legacy-fired",
        type: "alarm",
        label: "Legacy",
        createdAt: 1,
        targetAt: 2,
        status: "fired",
        firedAt: 3
      }]
    }));

    expect(data.items).toEqual([
      expect.objectContaining({ id: "legacy-fired", status: "completed", firedAt: 3, completedAt: 3 })
    ]);
  });

  it.each([
    ["a missing value", undefined],
    ["a non-array value", "1, 5"],
    ["an array without valid values", [0, 43_201, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5"]]
  ])("uses an independent full default for %s", (_description, quickTimerMinutes) => {
    const data = validateData({ settings: { quickTimerMinutes }, items: [] });

    expect(data.settings.quickTimerMinutes).toEqual([1, 5, 10, 15, 30, 60]);
    expect(data.settings.quickTimerMinutes).not.toBe(DEFAULT_SETTINGS.quickTimerMinutes);
  });

  it("filters, deduplicates, orders, and caps stored quick timer minutes", () => {
    const data = validateData({
      settings: {
        volume: 25,
        quickTimerMinutes: [30, 5, 30, 0, 10.5, Number.POSITIVE_INFINITY, 1, 60, 15, 10, 120, 240]
      },
      items: []
    });

    expect(data.settings.quickTimerMinutes).toEqual([30, 5, 1, 60, 15, 10]);
    expect(data.settings.volume).toBe(25);
  });

  it("does not share normalized quick timer arrays between results or defaults", () => {
    const first = validateData({ settings: {}, items: [] });
    const second = validateData({ settings: {}, items: [] });

    first.settings.quickTimerMinutes.push(120);

    expect(second.settings.quickTimerMinutes).toEqual([1, 5, 10, 15, 30, 60]);
    expect(DEFAULT_SETTINGS.quickTimerMinutes).toEqual([1, 5, 10, 15, 30, 60]);
  });

  it("preserves a valid paused timer", () => {
    const timer = { id: "one", type: "timer", label: "Tea", createdAt: 1, targetAt: 20, status: "paused", durationMs: 10_000, remainingMs: 5_000 };
    expect(validateData({ settings: {}, items: [timer] }).items[0]).toMatchObject(timer);
  });

  it("rejects an impossible paused alarm", () => {
    const alarm = { id: "alarm", type: "alarm", label: "", createdAt: 1, targetAt: 20, status: "paused" };
    expect(validateData({ settings: {}, items: [alarm] }).items).toEqual([]);
  });

  it("accepts a paused remainder above the restart duration within the global bound", () => {
    const timer = { id: "timer", type: "timer", label: "", createdAt: 1, targetAt: 20, status: "paused", durationMs: 10_000 };
    expect(validateData({ settings: {}, items: [{ ...timer, remainingMs: 10_001 }] }).items[0]).toMatchObject({
      durationMs: 10_000,
      remainingMs: 10_001
    });
    expect(validateData({ settings: {}, items: [{ ...timer, remainingMs: MAX_DURATION_MS }] }).items[0]).toMatchObject({
      durationMs: 10_000,
      remainingMs: MAX_DURATION_MS
    });
  });

  it("rejects a paused timer without a finite globally bounded remainder", () => {
    const timer = { id: "timer", type: "timer", label: "", createdAt: 1, targetAt: 20, status: "paused", durationMs: 10_000 };
    expect(validateData({ settings: {}, items: [timer] }).items).toEqual([]);
    expect(validateData({ settings: {}, items: [{ ...timer, remainingMs: -1 }] }).items).toEqual([]);
    expect(validateData({ settings: {}, items: [{ ...timer, remainingMs: Number.NaN }] }).items).toEqual([]);
    expect(validateData({ settings: {}, items: [{ ...timer, remainingMs: Number.POSITIVE_INFINITY }] }).items).toEqual([]);
    expect(validateData({ settings: {}, items: [{ ...timer, remainingMs: MAX_DURATION_MS + 1 }] }).items).toEqual([]);
  });

  it("rejects timers longer than the documented 30-day maximum", () => {
    const timer = { id: "timer", type: "timer", label: "", createdAt: 1, targetAt: 20, status: "active", durationMs: MAX_DURATION_MS + 1 };
    expect(validateData({ settings: {}, items: [timer] }).items).toEqual([]);
  });

  it.each([Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.NaN])("rejects required unrenderable timestamp %s", (invalidTimestamp) => {
    const alarm = { id: "alarm", type: "alarm", label: "", createdAt: 1, targetAt: 20, status: "active" };

    expect(validateData({ settings: {}, items: [{ ...alarm, createdAt: invalidTimestamp }] }).items).toEqual([]);
    expect(validateData({ settings: {}, items: [{ ...alarm, targetAt: invalidTimestamp }] }).items).toEqual([]);
  });

  it("preserves renderable Date boundaries and omits invalid optional timestamps", () => {
    const earliestDate = -8_640_000_000_000_000;
    const latestDate = 8_640_000_000_000_000;
    const alarm = {
      id: "boundary",
      type: "alarm",
      label: "",
      createdAt: earliestDate,
      targetAt: latestDate,
      firedAt: Number.MAX_VALUE,
      missedAt: Number.NaN,
      status: "fired",
    };

    expect(validateData({ settings: {}, items: [alarm] }).items[0]).toEqual({
      id: "boundary",
      type: "alarm",
      label: "",
      createdAt: earliestDate,
      targetAt: latestDate,
      status: "fired",
    });
  });

  it("keeps the first valid ID, drops empty and later duplicates, and preserves valid IDs", () => {
    const alarm = (id: string, label: string) => ({
      id,
      type: "alarm",
      label,
      createdAt: 1,
      targetAt: 20,
      status: "active",
    });
    const data = validateData({
      settings: {},
      items: [
        alarm("duplicate", "First"),
        alarm("duplicate", "Second"),
        alarm("", "Empty"),
        alarm("   ", "Whitespace"),
        alarm(" keep-spaces ", "Preserved"),
        { id: "valid-after-invalid", type: "alarm" },
        alarm("valid-after-invalid", "Valid")
      ]
    });

    expect(data.items.map((item) => item.id)).toEqual(["duplicate", " keep-spaces ", "valid-after-invalid"]);
    expect(data.items.map((item) => item.label)).toEqual(["First", "Preserved", "Valid"]);
  });
});
