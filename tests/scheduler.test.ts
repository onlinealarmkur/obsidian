import type { Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_POLL_TOLERANCE_MS,
  MISSED_NOTICE_MAX_AGE_MS,
  SCHEDULER_INTERVAL_MS
} from "../src/constants";
import { EN_I18N } from "../src/i18n";
import type { AlertService } from "../src/services/alert-service";
import { ItemService, type ProcessedDueItems } from "../src/services/item-service";
import { Scheduler } from "../src/services/scheduler";
import { DEFAULT_SETTINGS, type AlarmItem, type PluginData } from "../src/types";
import { getRecordedNotices, resetRecordedNotices } from "./mocks/obsidian";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  return {
    promise: new Promise<void>((resolve) => { resolvePromise = resolve; }),
    resolve: () => resolvePromise?.()
  };
}

interface ValueDeferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function valueDeferred<T>(): ValueDeferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  return {
    promise: new Promise<T>((resolve) => { resolvePromise = resolve; }),
    resolve: (value) => resolvePromise?.(value)
  };
}

describe("Scheduler persistence ordering", () => {
  beforeEach(() => resetRecordedNotices());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers one scheduler and checks on interval, focus, and visible wakeup", async () => {
    vi.useFakeTimers();
    const registeredIntervals: number[] = [];
    const registeredDomEvents: { type: string; callback: EventListenerOrEventListenerObject }[] = [];
    const plugin = {
      registerInterval: vi.fn((intervalId: number) => {
        registeredIntervals.push(intervalId);
        return intervalId;
      }),
      registerDomEvent: vi.fn((
        _target: EventTarget,
        type: string,
        callback: EventListenerOrEventListenerObject
      ) => {
        registeredDomEvents.push({ type, callback });
      })
    } as unknown as Plugin;
    const windowMock = { setInterval: globalThis.setInterval };
    const documentMock = { visibilityState: "hidden" };
    vi.stubGlobal("window", windowMock);
    vi.stubGlobal("document", documentMock);
    const processDue = vi.fn((_now?: number, _livePollToleranceMs?: number) =>
      Promise.resolve({ fired: [], missed: [] })
    );
    const items = { pendingAlerts: vi.fn(() => []), processDue, tick: vi.fn() } as unknown as ItemService;
    const scheduler = new Scheduler(plugin, items, { enqueue: vi.fn() } as unknown as AlertService, EN_I18N);
    const dispatch = (type: string): void => {
      const callback = registeredDomEvents.find((event) => event.type === type)?.callback;
      if (callback === undefined) throw new Error(`Missing ${type} registration.`);
      const event = new Event(type);
      if (typeof callback === "function") callback(event);
      else callback.handleEvent(event);
    };

    scheduler.start();
    scheduler.start();
    await vi.waitFor(() => expect(processDue).toHaveBeenCalledOnce());

    expect(registeredIntervals).toHaveLength(1);
    expect(registeredDomEvents.map((event) => event.type)).toEqual(["focus", "visibilitychange"]);

    vi.advanceTimersByTime(SCHEDULER_INTERVAL_MS);
    await vi.waitFor(() => expect(processDue).toHaveBeenCalledTimes(2));

    dispatch("focus");
    await vi.waitFor(() => expect(processDue).toHaveBeenCalledTimes(3));

    dispatch("visibilitychange");
    await Promise.resolve();
    expect(processDue).toHaveBeenCalledTimes(3);

    documentMock.visibilityState = "visible";
    dispatch("visibilitychange");
    await vi.waitFor(() => expect(processDue).toHaveBeenCalledTimes(4));

    scheduler.stop();
    scheduler.stop();
    scheduler.start();
    vi.advanceTimersByTime(SCHEDULER_INTERVAL_MS);
    dispatch("focus");
    dispatch("visibilitychange");
    await Promise.resolve();

    expect(processDue).toHaveBeenCalledTimes(4);
    expect(registeredIntervals).toHaveLength(1);
    expect(registeredDomEvents).toHaveLength(2);
    expect(processDue.mock.calls.map((call) => call[1])).toEqual([
      0,
      LIVE_POLL_TOLERANCE_MS,
      0,
      0
    ]);
  });

  it("uses catch-up semantics for direct checks unless live polling is explicit", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_500);
    const processDue = vi.fn((_now?: number, _livePollToleranceMs?: number) =>
      Promise.resolve({ fired: [], missed: [] })
    );
    const items = {
      pendingAlerts: vi.fn(() => []),
      processDue,
      tick: vi.fn()
    } as unknown as ItemService;
    const scheduler = new Scheduler(
      {} as Plugin,
      items,
      { enqueue: vi.fn() } as unknown as AlertService,
      EN_I18N
    );

    await scheduler.check();
    await scheduler.check("live-poll");

    expect(processDue.mock.calls).toEqual([
      [10_500, 0],
      [10_500, LIVE_POLL_TOLERANCE_MS]
    ]);
  });

  it("enqueues a slightly late zero-grace item only during a live poll", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_500);
    const liveDue: AlarmItem = {
      id: "live-zero-grace",
      type: "alarm",
      label: "Live",
      createdAt: 1,
      targetAt: 10_000,
      status: "active"
    };
    const liveData: PluginData = {
      schemaVersion: 2,
      settings: { ...DEFAULT_SETTINGS, overdueGraceMinutes: 0 },
      items: [liveDue]
    };
    const liveEnqueue = vi.fn();
    const liveScheduler = new Scheduler(
      {} as Plugin,
      new ItemService(liveData, { save: vi.fn(() => Promise.resolve()) }, EN_I18N),
      { enqueue: liveEnqueue } as unknown as AlertService,
      EN_I18N
    );

    await liveScheduler.check("live-poll");

    expect(liveData.items[0]).toMatchObject({
      id: liveDue.id,
      status: "fired",
      firedAt: 10_500
    });
    expect(liveEnqueue).toHaveBeenCalledOnce();
    expect(liveEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ id: liveDue.id, status: "fired" })
    );

    const catchUpDue: AlarmItem = {
      ...liveDue,
      id: "catch-up-zero-grace",
      label: "Catch-up"
    };
    const catchUpData: PluginData = {
      schemaVersion: 2,
      settings: { ...DEFAULT_SETTINGS, overdueGraceMinutes: 0 },
      items: [catchUpDue]
    };
    const catchUpEnqueue = vi.fn();
    const catchUpScheduler = new Scheduler(
      {} as Plugin,
      new ItemService(catchUpData, { save: vi.fn(() => Promise.resolve()) }, EN_I18N),
      { enqueue: catchUpEnqueue } as unknown as AlertService,
      EN_I18N
    );

    await catchUpScheduler.check();

    expect(catchUpData.items[0]).toMatchObject({
      id: catchUpDue.id,
      status: "missed",
      missedAt: 10_500
    });
    expect(catchUpEnqueue).not.toHaveBeenCalled();
  });

  it("waits for the fired state to save before enqueueing an alert", async () => {
    const due: AlarmItem = { id: "due", type: "alarm", label: "Due", createdAt: 1, targetAt: Date.now() - 100, status: "active" };
    const data: PluginData = { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS }, items: [due] };
    const saving = deferred();
    const save = vi.fn(() => saving.promise);
    const items = new ItemService(data, { save }, EN_I18N);
    const tick = vi.spyOn(items, "tick");
    const enqueue = vi.fn();
    const alerts = { enqueue } as unknown as AlertService;
    const plugin = {} as unknown as Plugin;
    const scheduler = new Scheduler(plugin, items, alerts, EN_I18N);

    const checking = scheduler.check();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(enqueue).not.toHaveBeenCalled();

    saving.resolve();
    await checking;

    expect(enqueue).toHaveBeenCalledOnce();
    expect(tick).toHaveBeenCalledOnce();
    expect(data.items[0]?.status).toBe("fired");
  });

  it("offers persisted pending alerts on every check and never offers completed history", async () => {
    const pending: AlarmItem = {
      id: "pending",
      type: "alarm",
      label: "Pending",
      createdAt: 1,
      targetAt: 2,
      status: "fired",
      firedAt: 3
    };
    const completed: AlarmItem = {
      ...pending,
      id: "completed",
      status: "completed",
      completedAt: 4
    };
    const items = new ItemService(
      { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS }, items: [completed, pending] },
      { save: vi.fn(() => Promise.resolve()) },
      EN_I18N
    );
    const enqueue = vi.fn();
    const scheduler = new Scheduler({} as Plugin, items, { enqueue } as unknown as AlertService, EN_I18N);

    await scheduler.check();
    await scheduler.check();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: pending.id, status: "fired" }));
    expect(enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: pending.id, status: "fired" }));
    expect(enqueue).not.toHaveBeenCalledWith(expect.objectContaining({ id: completed.id }));
  });

  it("skips a reserved cached alert until it is released", async () => {
    const pending: AlarmItem = {
      id: "reserved",
      type: "alarm",
      label: "Reserved",
      createdAt: 1,
      targetAt: 2,
      status: "fired",
      firedAt: 3
    };
    const items = new ItemService(
      { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS }, items: [pending] },
      { save: vi.fn(() => Promise.resolve()) },
      EN_I18N
    );
    const enqueue = vi.fn();
    const scheduler = new Scheduler({} as Plugin, items, { enqueue } as unknown as AlertService, EN_I18N);

    expect(items.reserveAlert(pending.id)).toBe(true);
    await scheduler.check();
    expect(enqueue).not.toHaveBeenCalled();

    items.releaseAlert(pending.id);
    await scheduler.check();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: pending.id, status: "fired" }));
  });

  it("offers an existing pending alert once before each newly fired result", async () => {
    const existing: AlarmItem = {
      id: "existing",
      type: "alarm",
      label: "Existing",
      createdAt: 1,
      targetAt: 2,
      status: "fired",
      firedAt: 3
    };
    const newlyFired: AlarmItem = {
      id: "new",
      type: "alarm",
      label: "New",
      createdAt: 4,
      targetAt: 5,
      status: "fired",
      firedAt: 6
    };
    const pendingAlerts = vi.fn(() => [existing]);
    const items = {
      pendingAlerts,
      processDue: vi.fn(() => Promise.resolve({ fired: [newlyFired], missed: [] })),
      tick: vi.fn()
    } as unknown as ItemService;
    const enqueue = vi.fn();
    const scheduler = new Scheduler({} as Plugin, items, { enqueue } as unknown as AlertService, EN_I18N);

    await scheduler.check();

    expect(enqueue.mock.calls).toEqual([[existing], [newlyFired]]);
    expect(pendingAlerts).toHaveBeenCalledOnce();
  });

  it("offers a persisted pending alert even when processing unrelated due data fails", async () => {
    const pending: AlarmItem = {
      id: "recover",
      type: "alarm",
      label: "Recover",
      createdAt: 1,
      targetAt: 2,
      status: "fired",
      firedAt: 3
    };
    const storageError = new Error("storage unavailable");
    const pendingAlerts = vi.fn(() => [pending]);
    const processDue = vi.fn(() => Promise.reject(storageError));
    const enqueue = vi.fn();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const items = { pendingAlerts, processDue, tick: vi.fn() } as unknown as ItemService;
    const scheduler = new Scheduler({} as Plugin, items, { enqueue } as unknown as AlertService, EN_I18N);

    await scheduler.check();

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(pending);
    expect(diagnostic).toHaveBeenCalledWith("Alarm and Timer scheduler could not update stored data.", storageError);
  });

  it("notices a missed item without enqueueing an alert", async () => {
    const missed: AlarmItem = {
      id: "missed",
      type: "alarm",
      label: "  Morning focus  ",
      createdAt: 1,
      targetAt: 2,
      status: "missed",
      missedAt: 3
    };
    const processDue = vi.fn(() => Promise.resolve({ fired: [], missed: [missed] }));
    const tick = vi.fn();
    const items = { pendingAlerts: vi.fn(() => []), processDue, tick } as unknown as ItemService;
    const enqueue = vi.fn();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = new Scheduler({} as Plugin, items, { enqueue } as unknown as AlertService, EN_I18N);

    await scheduler.check();

    expect(getRecordedNotices().map((notice) => notice.message)).toEqual([
      "Morning focus was missed while the app was inactive."
    ]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledOnce();
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("shows a missed notice through the 12-hour boundary but suppresses older notices", async () => {
    const targetAt = 1_000;
    const recent: AlarmItem = {
      id: "recent",
      type: "alarm",
      label: "Recent",
      createdAt: 1,
      targetAt,
      status: "missed",
      missedAt: targetAt + MISSED_NOTICE_MAX_AGE_MS
    };
    const stale: AlarmItem = {
      ...recent,
      id: "stale",
      label: "Stale",
      missedAt: targetAt + MISSED_NOTICE_MAX_AGE_MS + 1
    };
    const processDue = vi.fn(() => Promise.resolve({ fired: [], missed: [recent, stale] }));
    const tick = vi.fn();
    const items = { pendingAlerts: vi.fn(() => []), processDue, tick } as unknown as ItemService;
    const enqueue = vi.fn();
    const scheduler = new Scheduler({} as Plugin, items, { enqueue } as unknown as AlertService, EN_I18N);

    await scheduler.check();

    expect(getRecordedNotices().map((notice) => notice.message)).toEqual([
      "Recent was missed while the app was inactive."
    ]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledOnce();
  });

  it("records a five-day-old alarm as missed without a stale notice or alert", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-26T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const staleAlarm: AlarmItem = {
      id: "five-days-old",
      type: "alarm",
      label: "Old appointment",
      createdAt: now - 6 * 24 * 60 * 60 * 1_000,
      targetAt: now - 5 * 24 * 60 * 60 * 1_000,
      status: "active"
    };
    const data: PluginData = {
      schemaVersion: 2,
      settings: { ...DEFAULT_SETTINGS },
      items: [staleAlarm]
    };
    const save = vi.fn(() => Promise.resolve());
    const items = new ItemService(data, { save }, EN_I18N);
    const tick = vi.spyOn(items, "tick");
    const enqueue = vi.fn();
    const scheduler = new Scheduler({} as Plugin, items, { enqueue } as unknown as AlertService, EN_I18N);

    await scheduler.check();

    expect(data.items[0]).toMatchObject({
      id: "five-days-old",
      status: "missed",
      missedAt: now
    });
    expect(save).toHaveBeenCalledOnce();
    expect(getRecordedNotices()).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledOnce();
  });

  it("keeps delivering scheduler ticks without saving when no item is due", async () => {
    const save = vi.fn(() => Promise.resolve());
    const items = new ItemService({ schemaVersion: 1, settings: { ...DEFAULT_SETTINGS }, items: [] }, { save }, EN_I18N);
    const tick = vi.spyOn(items, "tick");
    const enqueue = vi.fn();
    const scheduler = new Scheduler({} as Plugin, items, { enqueue } as unknown as AlertService, EN_I18N);

    await scheduler.check();

    expect(save).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledOnce();
  });

  it("does not present, notify, or tick when stopped before processing resolves", async () => {
    const processing = valueDeferred<ProcessedDueItems>();
    const tick = vi.fn();
    const processDue = vi.fn(() => processing.promise);
    const items = { pendingAlerts: vi.fn(() => []), processDue, tick } as unknown as ItemService;
    const enqueue = vi.fn();
    const alerts = { enqueue } as unknown as AlertService;
    const scheduler = new Scheduler({} as Plugin, items, alerts, EN_I18N);
    const fired: AlarmItem = { id: "fired", type: "alarm", label: "Fired", createdAt: 1, targetAt: 2, status: "fired" };
    const missed: AlarmItem = { id: "missed", type: "alarm", label: "Missed", createdAt: 1, targetAt: 2, status: "missed" };

    const checking = scheduler.check();
    await vi.waitFor(() => expect(processDue).toHaveBeenCalledOnce());
    scheduler.stop();
    scheduler.stop();
    processing.resolve({ fired: [fired], missed: [missed] });
    await checking;
    await scheduler.check();

    expect(processDue).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    expect(getRecordedNotices()).toEqual([]);
  });

  it("logs the original storage error with the throttled user notice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
    const storageError = new Error("mock storage unavailable");
    const processDue = vi.fn(() => Promise.reject(storageError));
    const items = { pendingAlerts: vi.fn(() => []), processDue, tick: vi.fn() } as unknown as ItemService;
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = new Scheduler({} as Plugin, items, { enqueue: vi.fn() } as unknown as AlertService, EN_I18N);

    await scheduler.check();

    expect(getRecordedNotices().map((notice) => notice.message)).toEqual([
      "Alarm and timer data could not be updated. Check the developer console for storage errors."
    ]);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith("Alarm and Timer scheduler could not update stored data.", storageError);
  });

  it("throttles diagnostics with notices while resetting checking for retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
    const firstError = new Error("first mock failure");
    const suppressedError = new Error("suppressed mock failure");
    const laterError = new Error("later mock failure");
    const processDue = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(suppressedError)
      .mockRejectedValueOnce(laterError);
    const items = { pendingAlerts: vi.fn(() => []), processDue, tick: vi.fn() } as unknown as ItemService;
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = new Scheduler({} as Plugin, items, { enqueue: vi.fn() } as unknown as AlertService, EN_I18N);

    await scheduler.check();
    vi.advanceTimersByTime(59_999);
    await scheduler.check();

    expect(processDue).toHaveBeenCalledTimes(2);
    expect(getRecordedNotices()).toHaveLength(1);
    expect(diagnostic).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await scheduler.check();

    expect(processDue).toHaveBeenCalledTimes(3);
    expect(getRecordedNotices()).toHaveLength(2);
    expect(diagnostic.mock.calls).toEqual([
      ["Alarm and Timer scheduler could not update stored data.", firstError],
      ["Alarm and Timer scheduler could not update stored data.", laterError]
    ]);
  });
});
