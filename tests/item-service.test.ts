import { describe, expect, it, vi } from "vitest";
import { LIVE_POLL_TOLERANCE_MS } from "../src/constants";
import { EN_I18N } from "../src/i18n";
import { ItemService } from "../src/services/item-service";
import { DEFAULT_SETTINGS, type AlarmItem, type PluginData, type ScheduledItem, type TimerItem } from "../src/types";
import { getRecordedNotices, resetRecordedNotices } from "./mocks/obsidian";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  return {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (value) => resolvePromise?.(value),
    reject: (reason) => rejectPromise?.(reason)
  };
}

function dataWith(items: ScheduledItem[]): PluginData {
  return { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS }, items };
}

function timer(): TimerItem {
  return {
    id: "timer-1",
    type: "timer",
    label: "Tea",
    createdAt: 1,
    targetAt: Date.now() + 60_000,
    status: "active",
    durationMs: 60_000
  };
}

function alarm(id: string, status: AlarmItem["status"]): AlarmItem {
  return { id, type: "alarm", label: id, createdAt: 1, targetAt: 2, status };
}

function scheduledTimer(id: string, status: TimerItem["status"], targetAt: number, createdAt: number): TimerItem {
  const base = { id, type: "timer" as const, label: id, createdAt, targetAt, status, durationMs: 60_000 };
  return status === "paused" ? { ...base, status, remainingMs: 30_000 } : { ...base, status };
}

describe("ItemService persistence", () => {
  it("persists the complete timer action lifecycle", async () => {
    const data = dataWith([]);
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(data, { save }, EN_I18N);
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);

    const added = await service.addTimer(60_000, "  Tea  ");
    expect(added).toMatchObject({
      type: "timer",
      label: "Tea",
      createdAt: 10_000,
      targetAt: 70_000,
      durationMs: 60_000,
      status: "active"
    });

    now.mockReturnValue(20_000);
    await service.pauseTimer(added.id);
    expect(service.items[0]).toMatchObject({ status: "paused", remainingMs: 50_000 });

    now.mockReturnValue(30_000);
    await service.resumeTimer(added.id);
    expect(service.items[0]).toMatchObject({ status: "active", targetAt: 80_000 });
    expect(service.items[0]).not.toHaveProperty("remainingMs");

    now.mockReturnValue(40_000);
    await service.restartTimer(added.id);
    expect(service.items[0]).toMatchObject({ status: "active", targetAt: 100_000, durationMs: 60_000 });

    await service.cancel(added.id);
    expect(service.items[0]).toMatchObject({ status: "cancelled" });
    expect(save).toHaveBeenCalledTimes(5);
  });

  it("rejects invalid timer durations without persisting", async () => {
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([]), { save }, EN_I18N);

    await expect(service.addTimer(999, "short")).rejects.toThrow(RangeError);
    await expect(service.addTimer(Number.NaN, "invalid")).rejects.toThrow(RangeError);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ["past", 5_000],
    ["future", 15_000]
  ])("persists an ordinary %s alarm timestamp with its label and ID", async (_description, targetAt) => {
    const save = vi.fn((_next: PluginData) => Promise.resolve());
    const service = new ItemService(dataWith([]), { save }, EN_I18N);
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    const added = await service.addAlarm(targetAt, "  Appointment  ");

    expect(added).toMatchObject({ label: "Appointment", createdAt: 10_000, targetAt });
    expect(added.id).not.toHaveLength(0);
    expect(service.items).toEqual([added]);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0].items).toEqual([added]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["above the Date range", 8.64e15 + 1],
    ["below the Date range", -8.64e15 - 1]
  ])("rejects an alarm timestamp of %s without mutation, persistence, or a data event", async (_description, targetAt) => {
    const original = alarm("existing", "active");
    const save = vi.fn((_next: PluginData) => Promise.resolve());
    const service = new ItemService(dataWith([original]), { save }, EN_I18N);
    const events: string[] = [];
    service.subscribe((event) => events.push(event));

    await expect(service.addAlarm(targetAt, "Invalid")).rejects.toThrow("Alarm time must be a valid timestamp.");

    expect(service.items).toEqual([original]);
    expect(service.items[0]).toBe(original);
    expect(save).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("edits an active alarm while preserving identity and scheduling metadata", async () => {
    const original: AlarmItem = {
      id: "alarm-edit",
      type: "alarm",
      label: "Old label",
      createdAt: 100,
      targetAt: 1_000,
      status: "active",
    };
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([original]), { save }, EN_I18N);

    await expect(service.updateAlarm(original.id, 50_000, "  New label  ")).resolves.toBe(true);

    expect(service.items[0]).toEqual({ ...original, label: "New label", targetAt: 50_000 });
    expect(save).toHaveBeenCalledOnce();
  });

  it("rejects invalid edit values before persistence", async () => {
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([
      alarm("alarm", "active")
    ]), { save }, EN_I18N);

    await expect(service.updateAlarm("alarm", Number.NaN, "label")).rejects.toThrow(RangeError);
    await expect(service.updateAlarm("alarm", 8.64e15 + 1, "label")).rejects.toThrow(RangeError);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not edit completed or reserved items", async () => {
    const firedAlarm = alarm("reserved", "fired");
    const missedAlarm = alarm("missed", "missed");
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([firedAlarm, missedAlarm]), { save }, EN_I18N);
    expect(service.reserveAlert(firedAlarm.id)).toBe(true);

    await expect(service.updateAlarm(firedAlarm.id, 50_000, "new")).resolves.toBe(false);
    await expect(service.updateAlarm(missedAlarm.id, 50_000, "new")).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("rolls back a failed edit save", async () => {
    const original = alarm("rollback-edit", "active");
    const save = vi.fn(() => Promise.reject(new Error("storage unavailable")));
    const service = new ItemService(dataWith([original]), { save }, EN_I18N);

    await expect(service.updateAlarm(original.id, 50_000, "changed")).rejects.toThrow("storage unavailable");

    expect(service.items[0]).toEqual(original);
  });

  it("selects deterministic next items for every command-palette control", () => {
    const reserved = scheduledTimer("reserved-fired", "fired", 1, 1);
    const items: ScheduledItem[] = [
      reserved,
      scheduledTimer("active-z", "active", 100, 10),
      scheduledTimer("active-a", "active", 100, 10),
      scheduledTimer("active-created-first", "active", 100, 5),
      scheduledTimer("paused", "paused", 50, 20),
      alarm("active-alarm", "active"),
      alarm("cancelled-alarm", "cancelled")
    ];
    items[5] = { ...items[5] as AlarmItem, targetAt: 25, createdAt: 2 };
    const service = new ItemService(dataWith(items), { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
    expect(service.reserveAlert(reserved.id)).toBe(true);

    expect(service.findNextItem("pause")?.id).toBe("active-created-first");
    expect(service.findNextItem("resume")?.id).toBe("paused");
    expect(service.findNextItem("restart")?.id).toBe("paused");
    expect(service.findNextItem("cancel")?.id).toBe("active-alarm");
  });

  it("selects equal-time command targets by id regardless of storage order", () => {
    const service = new ItemService(dataWith([
      scheduledTimer("timer-z", "active", 100, 10),
      scheduledTimer("timer-a", "active", 100, 10)
    ]), { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    expect(service.findNextItem("pause")?.id).toBe("timer-a");
    expect(service.findNextItem("restart")?.id).toBe("timer-a");
    expect(service.findNextItem("cancel")?.id).toBe("timer-a");
  });

  it("serializes next-pause selection with each deferred save", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const first = scheduledTimer("first", "active", 10_000, 1);
    const second = scheduledTimer("second", "active", 20_000, 2);
    const firstSave = deferred<undefined>();
    const save = vi.fn<(_next: PluginData) => Promise<void>>()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(undefined);
    const service = new ItemService(dataWith([first, second]), { save }, EN_I18N);
    const events: string[] = [];
    service.subscribe((event) => events.push(event));

    const firstPause = service.controlNextItem("pause");
    const secondPause = service.controlNextItem("pause");

    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(service.items.map((item) => item.status)).toEqual(["active", "active"]);
    expect(events).toEqual([]);
    expect(save.mock.calls[0]?.[0].items).toEqual([
      expect.objectContaining({ id: first.id, status: "paused", remainingMs: 10_000 }),
      expect.objectContaining({ id: second.id, status: "active" })
    ]);

    firstSave.resolve(undefined);
    await expect(firstPause).resolves.toBe(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await expect(secondPause).resolves.toBe(true);

    expect(save.mock.calls[1]?.[0].items).toEqual([
      expect.objectContaining({ id: first.id, status: "paused", remainingMs: 10_000 }),
      expect.objectContaining({ id: second.id, status: "paused", remainingMs: 20_000 })
    ]);
    expect(service.items.map((item) => item.status)).toEqual(["paused", "paused"]);
    expect(events).toEqual(["data", "data"]);
  });

  it("returns false without saving when no item is eligible for the next control", async () => {
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([
      scheduledTimer("paused", "paused", 10_000, 1),
      scheduledTimer("cancelled", "cancelled", 20_000, 2)
    ]), { save }, EN_I18N);
    const events: string[] = [];
    service.subscribe((event) => events.push(event));

    await expect(service.controlNextItem("pause")).resolves.toBe(false);

    expect(save).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rolls back a failed next-item control save", async () => {
    const active = scheduledTimer("active", "active", 10_000, 1);
    const failure = new Error("storage unavailable");
    const save = vi.fn(() => Promise.reject(failure));
    const service = new ItemService(dataWith([active]), { save }, EN_I18N);
    const events: string[] = [];
    service.subscribe((event) => events.push(event));

    await expect(service.controlNextItem("pause")).rejects.toBe(failure);

    expect(service.items[0]).toEqual(active);
    expect(service.items[0]).not.toHaveProperty("remainingMs");
    expect(save).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });

  it("reselects the newly earliest timer for a second queued restart", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const first = scheduledTimer("first", "active", 1_100, 1);
    const second = scheduledTimer("second", "active", 1_200, 2);
    const save = vi.fn((_next: PluginData) => Promise.resolve());
    const service = new ItemService(dataWith([first, second]), { save }, EN_I18N);

    const restarts = await Promise.all([
      service.controlNextItem("restart"),
      service.controlNextItem("restart")
    ]);

    expect(restarts).toEqual([true, true]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[0].items).toEqual([
      expect.objectContaining({ id: first.id, status: "active", targetAt: 61_000 }),
      expect.objectContaining({ id: second.id, status: "active", targetAt: 1_200 })
    ]);
    expect(save.mock.calls[1]?.[0].items).toEqual([
      expect.objectContaining({ id: first.id, status: "active", targetAt: 61_000 }),
      expect.objectContaining({ id: second.id, status: "active", targetAt: 61_000 })
    ]);
  });

  it("rolls back a failed mutation and permits a retry", async () => {
    const data = dataWith([timer()]);
    let shouldFail = true;
    const save = vi.fn(() => shouldFail ? Promise.reject(new Error("storage unavailable")) : Promise.resolve());
    const service = new ItemService(data, { save }, EN_I18N);
    const events: string[] = [];
    service.subscribe((event) => events.push(event));

    await expect(service.pauseTimer("timer-1")).rejects.toThrow("storage unavailable");
    expect(service.items[0]).toMatchObject({ status: "active" });
    expect(service.items[0]).not.toHaveProperty("remainingMs");
    expect(events).toEqual([]);

    shouldFail = false;
    await service.pauseTimer("timer-1");
    expect(service.items[0]).toMatchObject({ status: "paused" });
    expect(events).toEqual(["data"]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("resolves a committed save and continues notifying after a listener throws", async () => {
    const save = vi.fn((_next: PluginData) => Promise.resolve());
    const service = new ItemService(dataWith([]), { save }, EN_I18N);
    const listenerError = new Error("broken listener");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const laterEvents: string[] = [];
    service.subscribe(() => { throw listenerError; });
    service.subscribe((event) => laterEvents.push(event));

    await expect(service.addAlarm(10_000, "Meeting")).resolves.toMatchObject({ label: "Meeting" });

    expect(save).toHaveBeenCalledOnce();
    expect(service.items).toHaveLength(1);
    expect(service.items[0]).toMatchObject({ label: "Meeting", status: "active" });
    expect(laterEvents).toEqual(["data"]);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith("Alarm and Timer item listener failed.", listenerError);
    diagnostic.mockRestore();
  });

  it("keeps tick delivery synchronous and non-throwing when a listener fails", () => {
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([]), { save }, EN_I18N);
    const listenerError = new Error("broken tick listener");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const laterEvents: string[] = [];
    service.subscribe(() => { throw listenerError; });
    service.subscribe((event) => laterEvents.push(event));

    expect(() => service.tick()).not.toThrow();

    expect(laterEvents).toEqual(["tick"]);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith("Alarm and Timer item listener failed.", listenerError);
    expect(save).not.toHaveBeenCalled();
    diagnostic.mockRestore();
  });

  it("serializes rapid saves and gives each call a stable snapshot", async () => {
    const data = dataWith([]);
    const firstSave = deferred<undefined>();
    const secondSave = deferred<undefined>();
    const save = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const service = new ItemService(data, { save }, EN_I18N);

    const firstAdd = service.addAlarm(10_000, "First");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const secondAdd = service.addAlarm(20_000, "Second");
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    firstSave.resolve(undefined);
    await firstAdd;
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    secondSave.resolve(undefined);
    await secondAdd;

    const firstSnapshot = save.mock.calls[0]?.[0] as PluginData | undefined;
    const secondSnapshot = save.mock.calls[1]?.[0] as PluginData | undefined;
    expect(firstSnapshot?.items.map((item) => item.label)).toEqual(["First"]);
    expect(secondSnapshot?.items.map((item) => item.label)).toEqual(["First", "Second"]);
    expect(service.items.map((item) => item.label)).toEqual(["First", "Second"]);
  });

  it("waits for the stable queue tail when another write is enqueued during a drain", async () => {
    const firstSave = deferred<undefined>();
    const secondSave = deferred<undefined>();
    const save = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const service = new ItemService(dataWith([]), { save }, EN_I18N);

    const firstAdd = service.addAlarm(10_000, "First");
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    let drained = false;
    const drain = service.waitForPendingDataWrites().then(() => { drained = true; });
    const secondAdd = service.addAlarm(20_000, "Second");

    await Promise.resolve();
    expect(drained).toBe(false);
    expect(save).toHaveBeenCalledOnce();

    firstSave.resolve(undefined);
    await firstAdd;
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(drained).toBe(false);

    secondSave.resolve(undefined);
    await Promise.all([secondAdd, drain]);
    expect(drained).toBe(true);
  });

  it("settles the drain after a rejected write without changing the caller rejection", async () => {
    const failedSave = deferred<undefined>();
    const failure = new Error("disk full");
    const service = new ItemService(dataWith([]), { save: vi.fn(() => failedSave.promise) }, EN_I18N);

    const adding = service.addAlarm(10_000, "Rejected");
    let drained = false;
    const drain = service.waitForPendingDataWrites().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    failedSave.reject(failure);

    await expect(adding).rejects.toBe(failure);
    await expect(drain).resolves.toBeUndefined();
    expect(drained).toBe(true);
    expect(service.items).toEqual([]);
  });

  it("does not visit terminal history when the cached active target is still in the future", async () => {
    const terminal = alarm("terminal-history", "cancelled");
    terminal.targetAt = 1_000;
    const future = alarm("future-active", "active");
    future.targetAt = 20_000;
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([terminal, future]), { save }, EN_I18N);
    let terminalStatusReads = 0;
    Object.defineProperty(terminal, "status", {
      configurable: true,
      enumerable: true,
      get: () => {
        ++terminalStatusReads;
        throw new Error("terminal history was visited");
      }
    });

    await expect(service.processDue(10_000)).resolves.toEqual({ fired: [], missed: [] });

    expect(terminalStatusReads).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it("refreshes cached due metadata across the timer lifecycle", async () => {
    const save = vi.fn((_next: PluginData) => Promise.resolve());
    const service = new ItemService(dataWith([]), { save }, EN_I18N);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);

    const added = await service.addTimer(60_000, "Cache lifecycle");
    await expect(service.processDue(60_000)).resolves.toMatchObject({
      fired: [expect.objectContaining({ id: added.id, status: "fired" })],
      missed: []
    });

    now.mockReturnValue(70_000);
    expect(service.reserveAlert(added.id)).toBe(true);
    await expect(service.acknowledgeFired(added.id)).resolves.toBe(true);
    service.releaseAlert(added.id);
    await service.restartTimer(added.id);
    now.mockReturnValue(80_000);
    await service.pauseTimer(added.id);
    const paused = service.items[0];
    if (paused === undefined) throw new Error("Missing paused timer.");
    let pausedStatusReads = 0;
    Object.defineProperty(paused, "status", {
      configurable: true,
      enumerable: true,
      get: () => {
        ++pausedStatusReads;
        return "paused";
      }
    });

    await expect(service.processDue(1_000_000)).resolves.toEqual({ fired: [], missed: [] });
    expect(pausedStatusReads).toBe(0);
    Object.defineProperty(paused, "status", {
      configurable: true,
      enumerable: true,
      value: "paused",
      writable: true
    });

    now.mockReturnValue(90_000);
    await service.resumeTimer(added.id);
    await expect(service.processDue(140_000)).resolves.toMatchObject({
      fired: [expect.objectContaining({ id: added.id, status: "fired" })],
      missed: []
    });

    now.mockReturnValue(150_000);
    expect(service.reserveAlert(added.id)).toBe(true);
    await expect(service.acknowledgeFired(added.id)).resolves.toBe(true);
    service.releaseAlert(added.id);
    await service.restartTimer(added.id);
    await expect(service.processDue(210_000)).resolves.toMatchObject({
      fired: [expect.objectContaining({ id: added.id, status: "fired" })],
      missed: []
    });

    now.mockReturnValue(460_000);
    expect(service.reserveAlert(added.id)).toBe(true);
    await expect(service.acknowledgeFired(added.id)).resolves.toBe(true);
    service.releaseAlert(added.id);
    await service.restartTimer(added.id);
    await service.cancel(added.id);
    const cancelled = service.items[0];
    if (cancelled === undefined) throw new Error("Missing cancelled timer.");
    let cancelledStatusReads = 0;
    Object.defineProperty(cancelled, "status", {
      configurable: true,
      enumerable: true,
      get: () => {
        ++cancelledStatusReads;
        return "cancelled";
      }
    });

    await expect(service.processDue(1_000_000)).resolves.toEqual({ fired: [], missed: [] });

    expect(cancelledStatusReads).toBe(0);
    expect(save).toHaveBeenCalledTimes(13);
  });

  it("keeps the active due target after clearing terminal history", async () => {
    const active = alarm("active-after-clear", "active");
    active.targetAt = 10_000;
    const terminal = alarm("terminal-to-clear", "cancelled");
    const save = vi.fn((_next: PluginData) => Promise.resolve());
    const service = new ItemService(dataWith([terminal, active]), { save }, EN_I18N);

    await service.clearCompleted();
    const processed = await service.processDue(10_000);

    expect(service.items.map((item) => item.id)).toEqual([active.id]);
    expect(processed.fired.map((item) => item.id)).toEqual([active.id]);
    expect(processed.missed).toEqual([]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("reports history command availability for every terminal item state", () => {
    const active = new ItemService(dataWith([alarm("active", "active")]), { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
    const completed = new ItemService(dataWith([alarm("completed", "completed")]), { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
    const missed = new ItemService(dataWith([alarm("missed", "missed")]), { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
    const cancelled = new ItemService(dataWith([alarm("cancelled", "cancelled")]), { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    expect(active.hasHistory()).toBe(false);
    expect(completed.hasHistory()).toBe(true);
    expect(missed.hasHistory()).toBe(true);
    expect(cancelled.hasHistory()).toBe(true);
  });

  it("reports when there is no history to clear", async () => {
    resetRecordedNotices();
    const active = timer();
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([active]), { save }, EN_I18N);

    await service.clearCompleted();

    expect(service.items).toEqual([active]);
    expect(save).not.toHaveBeenCalled();
    expect(getRecordedNotices()).toEqual([{ message: "There is no history to clear." }]);
  });

  it("restores the cached due target after a failed control save", async () => {
    const active = scheduledTimer("rollback-cache", "active", 10_000, 1);
    const failure = new Error("storage unavailable");
    const save = vi.fn<(_next: PluginData) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const service = new ItemService(dataWith([active]), { save }, EN_I18N);
    vi.spyOn(Date, "now").mockReturnValue(0);

    await expect(service.pauseTimer(active.id)).rejects.toBe(failure);
    const processed = await service.processDue(active.targetAt);

    expect(processed.fired.map((item) => item.id)).toEqual([active.id]);
    expect(processed.missed).toEqual([]);
    expect(service.items[0]).toMatchObject({ id: active.id, status: "fired" });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("persists a missed due transition and emits one data event", async () => {
    const due = alarm("missed-due", "active");
    due.targetAt = 10_000;
    const data = dataWith([due]);
    data.settings.overdueGraceMinutes = 2;
    const save = vi.fn((_next: PluginData) => Promise.resolve());
    const service = new ItemService(data, { save }, EN_I18N);
    const events: string[] = [];
    service.subscribe((event) => events.push(event));
    const now = due.targetAt + 2 * 60_000 + 1;

    const result = await service.processDue(now);

    expect(result.fired).toEqual([]);
    expect(result.missed).toEqual([
      expect.objectContaining({ id: due.id, status: "missed", missedAt: now })
    ]);
    expect(result.missed[0]).not.toHaveProperty("firedAt");
    expect(save).toHaveBeenCalledOnce();
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.items).toEqual([
      expect.objectContaining({ id: due.id, status: "missed", missedAt: now })
    ]);
    expect(saved?.items[0]).not.toHaveProperty("firedAt");
    expect(service.items[0]).toEqual(saved?.items[0]);
    expect(service.items[0]).not.toHaveProperty("firedAt");
    expect(events).toEqual(["data"]);
  });

  it("fires a zero-grace item slightly late only for a live scheduler poll", async () => {
    const liveDue = alarm("live-zero-grace", "active");
    liveDue.targetAt = 10_000;
    const liveData = dataWith([liveDue]);
    liveData.settings.overdueGraceMinutes = 0;
    const liveSave = vi.fn((_next: PluginData) => Promise.resolve());
    const liveService = new ItemService(liveData, { save: liveSave }, EN_I18N);

    const liveResult = await liveService.processDue(
      liveDue.targetAt + 500,
      LIVE_POLL_TOLERANCE_MS
    );

    expect(liveResult).toMatchObject({
      fired: [expect.objectContaining({ id: liveDue.id, status: "fired" })],
      missed: []
    });
    expect(liveSave).toHaveBeenCalledOnce();

    const catchUpDue = alarm("catch-up-zero-grace", "active");
    catchUpDue.targetAt = 10_000;
    const catchUpData = dataWith([catchUpDue]);
    catchUpData.settings.overdueGraceMinutes = 0;
    const catchUpService = new ItemService(catchUpData, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    const catchUpResult = await catchUpService.processDue(catchUpDue.targetAt + 500);

    expect(catchUpResult).toMatchObject({
      fired: [],
      missed: [expect.objectContaining({ id: catchUpDue.id, status: "missed" })]
    });
  });

  it("never extends a zero-grace live poll beyond its named tolerance", async () => {
    const due = alarm("late-live-poll", "active");
    due.targetAt = 10_000;
    const data = dataWith([due]);
    data.settings.overdueGraceMinutes = 0;
    const service = new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    const result = await service.processDue(
      due.targetAt + LIVE_POLL_TOLERANCE_MS + 1,
      LIVE_POLL_TOLERANCE_MS * 10
    );

    expect(result).toMatchObject({
      fired: [],
      missed: [expect.objectContaining({ id: due.id, status: "missed" })]
    });
  });

  it("includes the exact live-poll tolerance boundary", async () => {
    const due = alarm("live-poll-boundary", "active");
    due.targetAt = 10_000;
    const data = dataWith([due]);
    data.settings.overdueGraceMinutes = 0;
    const service = new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    const result = await service.processDue(
      due.targetAt + LIVE_POLL_TOLERANCE_MS,
      LIVE_POLL_TOLERANCE_MS
    );

    expect(result.fired.map((item) => item.id)).toEqual([due.id]);
    expect(result.missed).toEqual([]);
  });

  it.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY]
  ])("does not grant live tolerance for a %s value", async (_description, livePollToleranceMs) => {
    const due = alarm("invalid-live-poll-tolerance", "active");
    due.targetAt = 10_000;
    const data = dataWith([due]);
    data.settings.overdueGraceMinutes = 0;
    const service = new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    const result = await service.processDue(due.targetAt + 1, livePollToleranceMs);

    expect(result.fired).toEqual([]);
    expect(result.missed.map((item) => item.id)).toEqual([due.id]);
  });

  it("keeps a positive configured grace that is larger than live-poll tolerance", async () => {
    const withinGrace = alarm("within-configured-grace", "active");
    withinGrace.targetAt = 10_000;
    const withinData = dataWith([withinGrace]);
    withinData.settings.overdueGraceMinutes = 1;
    const withinService = new ItemService(withinData, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    const withinResult = await withinService.processDue(
      withinGrace.targetAt + 30_000,
      LIVE_POLL_TOLERANCE_MS
    );

    expect(withinResult.fired.map((item) => item.id)).toEqual([withinGrace.id]);
    expect(withinResult.missed).toEqual([]);

    const beyondGrace = alarm("beyond-configured-grace", "active");
    beyondGrace.targetAt = 10_000;
    const beyondData = dataWith([beyondGrace]);
    beyondData.settings.overdueGraceMinutes = 1;
    const beyondService = new ItemService(beyondData, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    const beyondResult = await beyondService.processDue(
      beyondGrace.targetAt + 60_001,
      LIVE_POLL_TOLERANCE_MS
    );

    expect(beyondResult.fired).toEqual([]);
    expect(beyondResult.missed.map((item) => item.id)).toEqual([beyondGrace.id]);
  });

  it("fires an exact target in catch-up and live-poll processing", async () => {
    const catchUpDue = alarm("exact-catch-up", "active");
    catchUpDue.targetAt = 10_000;
    const catchUpData = dataWith([catchUpDue]);
    catchUpData.settings.overdueGraceMinutes = 0;
    const catchUpService = new ItemService(catchUpData, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    const liveDue = alarm("exact-live", "active");
    liveDue.targetAt = 10_000;
    const liveData = dataWith([liveDue]);
    liveData.settings.overdueGraceMinutes = 0;
    const liveService = new ItemService(liveData, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    const catchUpResult = await catchUpService.processDue(catchUpDue.targetAt);
    const liveResult = await liveService.processDue(liveDue.targetAt, LIVE_POLL_TOLERANCE_MS);

    expect(catchUpResult.fired.map((item) => item.id)).toEqual([catchUpDue.id]);
    expect(liveResult.fired.map((item) => item.id)).toEqual([liveDue.id]);
  });

  it("rolls back a due transition so a later check can retry", async () => {
    const due = alarm("due", "active");
    const data = dataWith([due]);
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const service = new ItemService(data, { save }, EN_I18N);

    await expect(service.processDue(3)).rejects.toThrow("disk full");
    expect(service.items[0]?.status).toBe("active");

    const retried = await service.processDue(3);
    expect(retried.fired.map((item) => item.id)).toEqual(["due"]);
    expect(service.items[0]?.status).toBe("fired");
  });

  it("rolls back a failed missed transition and retries it exactly once", async () => {
    const due = alarm("missed-retry", "active");
    due.targetAt = 10_000;
    const data = dataWith([due]);
    data.settings.overdueGraceMinutes = 1;
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const service = new ItemService(data, { save }, EN_I18N);
    const events: string[] = [];
    service.subscribe((event) => events.push(event));
    const firstNow = due.targetAt + 60_001;
    const retryNow = firstNow + 1;

    await expect(service.processDue(firstNow)).rejects.toThrow("disk full");

    expect(service.items[0]).toMatchObject({ id: due.id, status: "active" });
    expect(service.items[0]).not.toHaveProperty("missedAt");
    expect(service.items[0]).not.toHaveProperty("firedAt");
    const failedSnapshot = save.mock.calls[0]?.[0] as PluginData | undefined;
    expect(failedSnapshot?.items.filter((item) => item.status === "fired")).toEqual([]);
    expect(failedSnapshot?.items[0]).not.toHaveProperty("firedAt");
    expect(events).toEqual([]);

    const retried = await service.processDue(retryNow);

    expect(retried.fired).toEqual([]);
    expect(retried.missed.map((item) => item.id)).toEqual([due.id]);
    const savedRetry = save.mock.calls[1]?.[0] as PluginData | undefined;
    expect(savedRetry?.items.filter((item) => item.status === "fired")).toEqual([]);
    expect(savedRetry?.items[0]).toMatchObject({ id: due.id, status: "missed", missedAt: retryNow });
    expect(savedRetry?.items[0]).not.toHaveProperty("firedAt");
    expect(service.items[0]).toEqual(savedRetry?.items[0]);
    expect(events).toEqual(["data"]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("returns an idle due result without entering the validation or save path", async () => {
    const future = alarm("future", "active");
    future.targetAt = 20_000;
    Object.defineProperty(future, "label", {
      configurable: true,
      enumerable: true,
      get: () => { throw new Error("validation should not read the label"); }
    });
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([future]), { save }, EN_I18N);

    await expect(service.processDue(10_000)).resolves.toEqual({ fired: [], missed: [] });

    expect(save).not.toHaveBeenCalled();
  });

  it("uses the post-save cache for due checks queued behind a pending write", async () => {
    const firstSave = deferred<undefined>();
    const save = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue(undefined);
    const service = new ItemService(dataWith([]), { save }, EN_I18N);

    const adding = service.addAlarm(1_000, "Queued");
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const firstCheck = service.processDue(2_000);
    const secondCheck = service.processDue(2_000);
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();

    firstSave.resolve(undefined);
    const added = await adding;
    const results = await Promise.all([firstCheck, secondCheck]);

    expect(results.flatMap((result) => result.fired).map((item) => item.id)).toEqual([added.id]);
    expect(results.flatMap((result) => result.missed)).toEqual([]);
    expect(service.items).toHaveLength(1);
    expect(service.items[0]).toMatchObject({ id: added.id, status: "fired", firedAt: 2_000 });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("does not save scheduler ticks", () => {
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([]), { save }, EN_I18N);

    service.tick();

    expect(save).not.toHaveBeenCalled();
  });

  it("protects every pending fired item from history clearing", async () => {
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([
      alarm("active-alert", "fired"),
      alarm("queued-alert", "fired"),
      alarm("old", "cancelled")
    ]), { save }, EN_I18N);
    expect(service.reserveAlert("active-alert")).toBe(true);
    expect(service.reserveAlert("queued-alert")).toBe(true);

    await service.clearCompleted();
    expect(service.items.map((item) => item.id)).toEqual(["active-alert", "queued-alert"]);

    service.releaseAlert("active-alert");
    await service.clearCompleted();
    expect(service.items.map((item) => item.id)).toEqual(["active-alert", "queued-alert"]);
  });

  it("orders pending alerts deterministically without exposing its cached array", () => {
    const first = alarm("b", "fired");
    first.targetAt = 10;
    first.createdAt = 1;
    const second = alarm("a", "fired");
    second.targetAt = 10;
    second.createdAt = 1;
    const later = alarm("later", "fired");
    later.targetAt = 20;
    const completed = alarm("completed", "completed");
    const service = new ItemService(dataWith([later, completed, first, second]), { save: vi.fn(() => Promise.resolve()) }, EN_I18N);

    const pending = service.pendingAlerts();
    expect(pending.map((item) => item.id)).toEqual(["a", "b", "later"]);

    const returnedFirst = pending[0];
    if (returnedFirst === undefined) throw new Error("Expected a pending alert.");
    returnedFirst.label = "Mutated outside the service";
    returnedFirst.status = "completed";
    pending.reverse();
    pending.pop();
    expect(service.pendingAlerts().map((item) => item.id)).toEqual(["a", "b", "later"]);
    expect(service.pendingAlerts()[0]).toMatchObject({ id: "a", label: "a", status: "fired" });
    expect(service.items.find((item) => item.id === "a")).toMatchObject({ label: "a", status: "fired" });
  });

  it("reads retained terminal history only while rebuilding the fired cache", async () => {
    const inspectedTerminal = alarm("inspected-terminal", "cancelled");
    const statusRead = vi.fn(() => "cancelled" as const);
    Object.defineProperty(inspectedTerminal, "status", {
      configurable: true,
      enumerable: true,
      get: statusRead
    });
    const retainedHistory = Array.from(
      { length: 2_000 },
      (_, index) => alarm(`terminal-${index}`, index % 2 === 0 ? "completed" : "missed")
    );
    const fired = alarm("pending", "fired");
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([fired, inspectedTerminal, ...retainedHistory]), { save }, EN_I18N);
    const readsAfterConstruction = statusRead.mock.calls.length;

    expect(readsAfterConstruction).toBeGreaterThan(0);
    for (let index = 0; index < 100; index += 1) {
      expect(service.pendingAlerts().map((item) => item.id)).toEqual(["pending"]);
    }
    expect(statusRead).toHaveBeenCalledTimes(readsAfterConstruction);

    expect(service.reserveAlert(fired.id)).toBe(true);
    expect(service.pendingAlerts()).toEqual([]);
    service.releaseAlert(fired.id);
    expect(service.pendingAlerts().map((item) => item.id)).toEqual(["pending"]);

    await service.clearCompleted();
    expect(statusRead.mock.calls.length).toBeGreaterThan(readsAfterConstruction);
    const readsAfterReplacement = statusRead.mock.calls.length;
    service.pendingAlerts();
    service.pendingAlerts();
    expect(statusRead).toHaveBeenCalledTimes(readsAfterReplacement);
  });

  it("acknowledges only a reserved pending alert and rolls back a failed save", async () => {
    const fired = alarm("pending", "fired");
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = new ItemService(dataWith([fired]), { save }, EN_I18N);
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    await expect(service.acknowledgeFired(fired.id)).resolves.toBe(false);
    expect(service.reserveAlert(fired.id)).toBe(true);
    await expect(service.acknowledgeFired(fired.id)).rejects.toThrow("storage unavailable");
    expect(service.items[0]).toMatchObject({ id: fired.id, status: "fired" });
    expect(service.items[0]).not.toHaveProperty("completedAt");
    expect(service.isAlertReserved(fired.id)).toBe(true);
    expect(service.pendingAlerts()).toEqual([]);

    service.releaseAlert(fired.id);
    expect(service.pendingAlerts().map((item) => item.id)).toEqual([fired.id]);
    expect(service.reserveAlert(fired.id)).toBe(true);

    await expect(service.acknowledgeFired(fired.id)).resolves.toBe(true);
    expect(service.items[0]).toMatchObject({ id: fired.id, status: "completed", completedAt: 10_000 });
    expect(service.pendingAlerts()).toEqual([]);
    service.releaseAlert(fired.id);
    expect(service.pendingAlerts()).toEqual([]);
  });

  it("repeats a reserved completed timer only through the alert action", async () => {
    const firedTimer: TimerItem = {
      id: "reserved-timer",
      type: "timer",
      label: "Tea",
      createdAt: 1,
      targetAt: 2,
      status: "fired",
      firedAt: 3,
      durationMs: 60_000
    };
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([firedTimer]), { save }, EN_I18N);
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    expect(service.reserveAlert(firedTimer.id)).toBe(true);
    expect(service.isAlertReserved(firedTimer.id)).toBe(true);
    await service.restartTimer(firedTimer.id);
    expect(service.items[0]).toMatchObject({ id: firedTimer.id, status: "fired", targetAt: 2 });
    expect(save).not.toHaveBeenCalled();

    await expect(service.restartFiredTimer(firedTimer.id)).resolves.toBe(true);
    expect(service.items[0]).toMatchObject({ id: firedTimer.id, status: "active", targetAt: 70_000, durationMs: 60_000 });
    expect(save).toHaveBeenCalledOnce();

    service.releaseAlert(firedTimer.id);
    expect(service.isAlertReserved(firedTimer.id)).toBe(false);
    expect(service.pendingAlerts()).toEqual([]);
    await service.restartTimer(firedTimer.id);
    expect(service.items[0]).toMatchObject({ id: firedTimer.id, status: "active", targetAt: 70_000, durationMs: 60_000 });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("rolls back a failed completed-timer repeat and keeps the alert reservation", async () => {
    const firedTimer: TimerItem = {
      id: "repeat-rollback",
      type: "timer",
      label: "Tea",
      createdAt: 1,
      targetAt: 2,
      status: "fired",
      firedAt: 3,
      durationMs: 60_000
    };
    const save = vi.fn(() => Promise.reject(new Error("storage unavailable")));
    const service = new ItemService(dataWith([firedTimer]), { save }, EN_I18N);
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    expect(service.reserveAlert(firedTimer.id)).toBe(true);

    await expect(service.restartFiredTimer(firedTimer.id)).rejects.toThrow("storage unavailable");

    expect(service.items[0]).toEqual(firedTimer);
    expect(service.isAlertReserved(firedTimer.id)).toBe(true);
    expect(service.pendingAlerts()).toEqual([]);
    service.releaseAlert(firedTimer.id);
    expect(service.pendingAlerts().map((item) => item.id)).toEqual([firedTimer.id]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("reports a missing completed timer without saving", async () => {
    const save = vi.fn(() => Promise.resolve());
    const service = new ItemService(dataWith([]), { save }, EN_I18N);

    await expect(service.restartFiredTimer("missing")).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
