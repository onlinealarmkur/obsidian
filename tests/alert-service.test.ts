import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertService } from "../src/services/alert-service";
import { createI18n, EN_I18N } from "../src/i18n";
import { ItemService } from "../src/services/item-service";
import { AlertModal } from "../src/ui/alert-modal";
import { DEFAULT_SETTINGS, type AlarmItem, type PluginData, type TimerItem } from "../src/types";
import { formatDateTime } from "../src/utils/formatting";
import {
  clickMockElementByText,
  failNextModalOpen,
  getCreatedModals,
  getMockElementTexts,
  getRecordedNotices,
  resetCreatedModals,
  resetRecordedNotices,
  type MockElement
} from "./mocks/obsidian";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  return {
    promise: new Promise<T>((resolve) => { resolvePromise = resolve; }),
    resolve: (value) => resolvePromise?.(value)
  };
}

function alarm(id: string): AlarmItem {
  return { id, type: "alarm", label: id, createdAt: 1, targetAt: 2, status: "fired", firedAt: 3 };
}

function timer(id: string): TimerItem {
  return {
    id,
    type: "timer",
    label: id,
    createdAt: 1,
    targetAt: 2,
    status: "fired",
    firedAt: 3,
    durationMs: 60_000
  };
}

function pluginData(items: AlarmItem[]): PluginData {
  return { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, enableSound: false }, items };
}

function findElementByText(root: MockElement | undefined, text: string): MockElement | undefined {
  if (root === undefined) return undefined;
  if (root.text === text) return root;
  for (const child of root.children) {
    const match = findElementByText(child, text);
    if (match !== undefined) return match;
  }
  return undefined;
}

const app = {} as App;

describe("AlertService", () => {
  beforeEach(() => {
    resetCreatedModals();
    resetRecordedNotices();
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports command availability only while an alert modal is active", () => {
    const fired = alarm("availability");
    const items = new ItemService(
      pluginData([fired]),
      { save: vi.fn(() => Promise.resolve()) },
      EN_I18N
    );
    const alerts = new AlertService(
      app,
      items,
      { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() },
      () => Promise.resolve(),
      EN_I18N
    );

    expect(alerts.hasActiveAlert()).toBe(false);
    alerts.enqueue(fired);
    expect(alerts.hasActiveAlert()).toBe(true);
    alerts.stop();
    expect(alerts.hasActiveAlert()).toBe(false);
  });

  it("reserves simultaneous active and queued alerts until each is dismissed", async () => {
    const first = alarm("first");
    const second = alarm("second");
    const data = pluginData([first, second]);
    const save = vi.fn(() => Promise.resolve());
    const items = new ItemService(data, { save }, EN_I18N);
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const alerts = new AlertService(app, items, audio, () => Promise.resolve(), EN_I18N);

    alerts.enqueue(first);
    alerts.enqueue(second);
    await items.clearCompleted();
    expect(items.items.map((item) => item.id)).toEqual(["first", "second"]);

    alerts.stopActive();
    await vi.waitFor(() => expect(items.items[0]?.status).toBe("completed"));
    await items.clearCompleted();
    expect(items.items.map((item) => item.id)).toEqual(["second"]);
    expect(getRecordedNotices().map((notice) => notice.message).filter((message) => message.startsWith("Alarm:"))).toEqual([
      "Alarm: first",
      "Alarm: second"
    ]);
  });

  it("localizes the notice, modal, and timer actions from the injected language", () => {
    const fired = timer("Çay");
    const data: PluginData = {
      schemaVersion: 2,
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      items: [fired]
    };
    const i18n = createI18n("tr");
    const items = new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, i18n);
    const alerts = new AlertService(
      app,
      items,
      { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() },
      () => Promise.resolve(),
      i18n
    );

    alerts.enqueue(fired);

    expect(getRecordedNotices()).toEqual([{ message: "Zamanlayıcı sona erdi: Çay" }]);
    const modal = getCreatedModals()[0];
    expect(modal?.title).toBe("Zamanlayıcı");
    expect(getMockElementTexts(modal?.contentEl)).toEqual(expect.arrayContaining(["Yeniden başlat", "Durdur"]));
  });

  it("presents a re-enqueued persisted pending alert only once", () => {
    const fired = alarm("reload-gap");
    const items = new ItemService(pluginData([fired]), { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
    const alerts = new AlertService(
      app,
      items,
      { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() },
      () => Promise.resolve(),
      EN_I18N
    );

    alerts.enqueue(fired);
    alerts.enqueue(fired);

    expect(getCreatedModals()).toHaveLength(1);
    expect(getRecordedNotices()).toEqual([{ message: "Alarm: reload-gap" }]);
  });

  it("releases active and queued reservations when alerting stops", async () => {
    const first = alarm("first");
    const second = alarm("second");
    const save = vi.fn(() => Promise.resolve());
    const items = new ItemService(pluginData([first, second]), { save }, EN_I18N);
    const release = vi.spyOn(items, "releaseAlert");
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const alerts = new AlertService(app, items, audio, () => Promise.resolve(), EN_I18N);
    alerts.enqueue(first);
    alerts.enqueue(second);

    alerts.stop();
    await items.clearCompleted();

    expect(release).toHaveBeenCalledWith("first");
    expect(release).toHaveBeenCalledWith("second");
    expect(items.items.map((item) => item.id)).toEqual(["first", "second"]);
    expect(audio.stop).toHaveBeenCalled();
  });

  it("permanently ignores late enqueue after repeated stop", () => {
    const reserveAlert = vi.fn(() => true);
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert,
      releaseAlert: vi.fn(),
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const alerts = new AlertService(app, items, audio, () => Promise.resolve(), EN_I18N);

    alerts.stop();
    alerts.stop();
    alerts.enqueue(alarm("late"));

    expect(reserveAlert).not.toHaveBeenCalled();
    expect(getCreatedModals()).toEqual([]);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("does not create system notifications when disabled or permission is ungranted", () => {
    const created: unknown[] = [];
    class TestNotification {
      public static permission = "granted";
      public onclick: (() => void) | null = null;
      public constructor() { created.push(this); }
      public close(): void { return; }
    }
    vi.stubGlobal("Notification", TestNotification);
    const disabledItem = alarm("disabled");
    const disabledItems = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false, enableSystemNotifications: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert: vi.fn(),
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const disabledAlerts = new AlertService(app, disabledItems, audio, () => Promise.resolve(), EN_I18N);

    disabledAlerts.enqueue(disabledItem);
    expect(created).toEqual([]);

    TestNotification.permission = "denied";
    const deniedItem = alarm("denied");
    const deniedItems = { ...disabledItems, settings: { ...disabledItems.settings, enableSystemNotifications: true } };
    const deniedAlerts = new AlertService(app, deniedItems, audio, () => Promise.resolve(), EN_I18N);
    deniedAlerts.enqueue(deniedItem);

    expect(created).toEqual([]);
  });

  it("closes each queued notification and keeps stale clicks isolated from the active alert", async () => {
    class TestNotification {
      public static readonly created: TestNotification[] = [];
      public static permission = "granted";
      public onclick: (() => void) | null = null;
      public close = vi.fn();
      public constructor() { TestNotification.created.push(this); }
    }
    vi.stubGlobal("Notification", TestNotification);
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
      focus: vi.fn()
    });
    const first = alarm("first-notification");
    const second = alarm("second-notification");
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false, enableSystemNotifications: true },
      reserveAlert: vi.fn(() => true),
      releaseAlert: vi.fn(),
      acknowledgeFired: vi.fn(() => Promise.resolve(true))
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const openAlarmView = vi.fn(() => Promise.resolve());
    const alerts = new AlertService(app, items, audio, openAlarmView, EN_I18N);

    alerts.enqueue(first);
    alerts.enqueue(second);
    const firstNotification = TestNotification.created[0];
    expect(TestNotification.created).toHaveLength(1);

    alerts.stopActive();
    await vi.waitFor(() => expect(TestNotification.created).toHaveLength(2));
    const secondNotification = TestNotification.created[1];
    expect(firstNotification?.close).toHaveBeenCalledOnce();

    firstNotification?.onclick?.();
    await Promise.resolve();
    expect(firstNotification?.close).toHaveBeenCalledTimes(2);
    expect(openAlarmView).not.toHaveBeenCalled();
    expect(secondNotification?.close).not.toHaveBeenCalled();

    alerts.stop();
    expect(secondNotification?.close).toHaveBeenCalledOnce();
  });

  it("closes, focuses, and opens in order when a system notification is clicked", async () => {
    const order: string[] = [];
    class TestNotification {
      public static readonly created: TestNotification[] = [];
      public static permission = "granted";
      public onclick: (() => void) | null = null;
      public constructor() { TestNotification.created.push(this); }
      public close(): void { order.push("close"); }
    }
    vi.stubGlobal("Notification", TestNotification);
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
      focus: vi.fn(() => { order.push("focus"); })
    });
    const fired = alarm("clickable");
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false, enableSystemNotifications: true },
      reserveAlert: vi.fn(() => true),
      releaseAlert: vi.fn(),
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const openAlarmView = vi.fn(() => { order.push("open"); return Promise.resolve(); });
    const alerts = new AlertService(app, items, audio, openAlarmView, EN_I18N);

    alerts.enqueue(fired);
    const created = TestNotification.created[0];
    created?.onclick?.();

    await vi.waitFor(() => expect(openAlarmView).toHaveBeenCalledOnce());
    expect(order).toEqual(["close", "focus", "open"]);
    expect(getCreatedModals()[0]?.isOpen).toBe(true);
    expect(items.releaseAlert).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it("reports a rejected notification opener while keeping the alert active", async () => {
    class TestNotification {
      public static readonly created: TestNotification[] = [];
      public static permission = "granted";
      public onclick: (() => void) | null = null;
      public constructor() { TestNotification.created.push(this); }
      public close(): void { return; }
    }
    vi.stubGlobal("Notification", TestNotification);
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
      focus: vi.fn()
    });
    const fired = alarm("open-failure");
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false, enableSystemNotifications: true },
      reserveAlert: vi.fn(() => true),
      releaseAlert: vi.fn(),
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const alerts = new AlertService(app, items, audio, () => Promise.reject(new Error("workspace failed")), EN_I18N);

    alerts.enqueue(fired);
    const created = TestNotification.created[0];
    created?.onclick?.();

    await vi.waitFor(() => expect(getRecordedNotices().map((notice) => notice.message)).toContain(
      "The system notification action could not be completed."
    ));
    expect(getCreatedModals()[0]?.isOpen).toBe(true);
    expect(items.releaseAlert).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
    diagnostic.mockRestore();
  });

  it("continues opening the sidebar and reports a rejected focus attempt", async () => {
    class TestNotification {
      public static readonly created: TestNotification[] = [];
      public static permission = "granted";
      public onclick: (() => void) | null = null;
      public constructor() { TestNotification.created.push(this); }
      public close(): void { return; }
    }
    vi.stubGlobal("Notification", TestNotification);
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
      focus: vi.fn(() => Promise.reject(new Error("focus failed")))
    });
    const fired = alarm("focus-failure");
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false, enableSystemNotifications: true },
      reserveAlert: vi.fn(() => true),
      releaseAlert: vi.fn(),
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const openAlarmView = vi.fn(() => Promise.resolve());
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const alerts = new AlertService(app, items, audio, openAlarmView, EN_I18N);

    alerts.enqueue(fired);
    TestNotification.created[0]?.onclick?.();

    await vi.waitFor(() => expect(openAlarmView).toHaveBeenCalledOnce());
    expect(getRecordedNotices().map((notice) => notice.message)).toContain("The system notification action could not be completed.");
    expect(getCreatedModals()[0]?.isOpen).toBe(true);
    expect(items.releaseAlert).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
    diagnostic.mockRestore();
  });

  it("ignores notification clicks after alert-service shutdown", async () => {
    class TestNotification {
      public static readonly created: TestNotification[] = [];
      public static permission = "granted";
      public onclick: (() => void) | null = null;
      public constructor() { TestNotification.created.push(this); }
      public close = vi.fn();
    }
    vi.stubGlobal("Notification", TestNotification);
    const fired = alarm("stopped-click");
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false, enableSystemNotifications: true },
      reserveAlert: vi.fn(() => true),
      releaseAlert: vi.fn(),
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const openAlarmView = vi.fn(() => Promise.resolve());
    const alerts = new AlertService(app, items, audio, openAlarmView, EN_I18N);
    alerts.enqueue(fired);
    const created = TestNotification.created[0];

    alerts.stop();
    created?.onclick?.();
    await Promise.resolve();

    expect(created?.close).toHaveBeenCalledTimes(2);
    expect(openAlarmView).not.toHaveBeenCalled();
  });

  it("rolls back a failed modal open and presents the next queued alert", async () => {
    class TestNotification {
      public static readonly created: TestNotification[] = [];
      public static permission = "granted";
      public onclick: (() => void) | null = null;
      public readonly close: ReturnType<typeof vi.fn>;
      public constructor() {
        const shouldThrow = TestNotification.created.length === 0;
        this.close = vi.fn(() => {
          if (shouldThrow) throw new Error("mock notification close failed");
        });
        TestNotification.created.push(this);
      }
    }
    vi.stubGlobal("Notification", TestNotification);
    const first = alarm("cannot-present");
    const second = alarm("next-alert");
    const releaseAlert = vi.fn();
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false, enableSystemNotifications: true },
      reserveAlert: vi.fn(() => true),
      releaseAlert,
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const alerts = new AlertService(app, items, audio, () => Promise.resolve(), EN_I18N);
    failNextModalOpen(new Error("mock modal open failed"));

    alerts.enqueue(first);
    alerts.enqueue(second);
    await vi.waitFor(() => expect(getCreatedModals()).toHaveLength(2));

    expect(getCreatedModals()[0]?.isOpen).toBe(false);
    expect(getCreatedModals()[0]?.closeCount).toBe(1);
    expect(getCreatedModals()[1]?.isOpen).toBe(true);
    expect(TestNotification.created).toHaveLength(2);
    expect(TestNotification.created[0]?.close).toHaveBeenCalledOnce();
    expect(TestNotification.created[1]?.close).not.toHaveBeenCalled();
    expect(releaseAlert.mock.calls.filter(([id]) => id === first.id)).toHaveLength(1);
    expect(getRecordedNotices().map((notice) => notice.message)).toContain("An alert could not be shown. Continuing with the next alert.");
    expect(diagnostic).toHaveBeenCalledWith("Alarm and Timer alert presentation failed.", expect.any(Error));

    alerts.stop();
    alerts.stop();
    expect(TestNotification.created[1]?.close).toHaveBeenCalledOnce();
    expect(releaseAlert.mock.calls.filter(([id]) => id === first.id)).toHaveLength(1);
    expect(releaseAlert.mock.calls.filter(([id]) => id === second.id)).toHaveLength(1);
    expect(audio.stop).toHaveBeenCalledTimes(2);
    diagnostic.mockRestore();
  });

  it("offers only Stop when an alarm fires", () => {
    const fired = alarm("stop-only");
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert: vi.fn()
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const alerts = new AlertService(app, items, audio, () => Promise.resolve(), EN_I18N);

    alerts.enqueue(fired);
    const texts = getMockElementTexts(getCreatedModals()[0]?.contentEl);

    expect(texts).toContain("Stop");
    expect(texts).not.toContain("Restart");
  });

  it("uses complete type-aware notices for labeled and blank alerts", async () => {
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert: vi.fn(),
      acknowledgeFired: vi.fn(() => Promise.resolve(true))
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const alerts = new AlertService(app, items, audio, () => Promise.resolve(), EN_I18N);
    const labeledTimer = timer("timer-id");
    labeledTimer.label = "Tea is ready";
    const blankAlarm = alarm("alarm-id");
    blankAlarm.label = "";
    const blankTimer = timer("blank-timer");
    blankTimer.label = "";

    alerts.enqueue(labeledTimer);
    alerts.stopActive();
    await vi.waitFor(() => expect(getCreatedModals()).toHaveLength(1));
    alerts.enqueue(blankAlarm);
    await vi.waitFor(() => expect(getCreatedModals()).toHaveLength(2));
    alerts.stopActive();
    alerts.enqueue(blankTimer);
    await vi.waitFor(() => expect(getCreatedModals()).toHaveLength(3));
    expect(getRecordedNotices().map((notice) => notice.message)).toEqual([
      "Timer finished: Tea is ready",
      "Alarm is ready.",
      "Timer finished."
    ]);
  });

  it("disables competing alert actions while Stop is saving and acknowledges once", async () => {
    const acknowledgement = deferred<boolean>();
    const fired = timer("stop-race");
    const acknowledgeFired = vi.fn(() => acknowledgement.promise);
    const releaseAlert = vi.fn();
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert,
      acknowledgeFired,
      restartFiredTimer: vi.fn(() => Promise.resolve(true))
    };
    const alerts = new AlertService(app, items, { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() }, () => Promise.resolve(), EN_I18N);
    alerts.enqueue(fired);
    const modal = getCreatedModals()[0];

    expect(clickMockElementByText(modal?.contentEl, "Stop")).toBe(true);
    expect(findElementByText(modal?.contentEl, "Stop")?.disabled).toBe(true);
    expect(findElementByText(modal?.contentEl, "Restart")?.disabled).toBe(true);
    expect(clickMockElementByText(modal?.contentEl, "Restart")).toBe(true);
    expect(acknowledgeFired).toHaveBeenCalledOnce();
    expect(items.restartFiredTimer).not.toHaveBeenCalled();
    expect(releaseAlert).not.toHaveBeenCalled();

    acknowledgement.resolve(true);
    await vi.waitFor(() => expect(releaseAlert).toHaveBeenCalledOnce());
  });

  it("keeps a failed Stop durable and actionable while the modal remains open", async () => {
    const fired = alarm("ack-failure");
    const items = new ItemService(pluginData([fired]), {
      save: vi.fn(() => Promise.reject(new Error("storage unavailable")))
    }, EN_I18N);
    const alerts = new AlertService(
      app,
      items,
      { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() },
      () => Promise.resolve(),
      EN_I18N
    );
    alerts.enqueue(fired);
    const modal = getCreatedModals()[0];

    expect(clickMockElementByText(modal?.contentEl, "Stop")).toBe(true);
    await vi.waitFor(() => expect(getRecordedNotices().map((notice) => notice.message)).toContain(
      "The alert could not be stopped."
    ));

    expect(modal?.isOpen).toBe(true);
    expect(findElementByText(modal?.contentEl, "Stop")?.disabled).toBe(false);
    expect(items.items[0]).toMatchObject({ id: fired.id, status: "fired" });
    expect(items.isAlertReserved(fired.id)).toBe(true);
  });

  it("releases a closed alert after acknowledgement failure so it can be presented again", async () => {
    const fired = alarm("closed-failure");
    const save = vi.fn(() => Promise.reject(new Error("storage unavailable")));
    const items = new ItemService(pluginData([fired]), { save }, EN_I18N);
    const alerts = new AlertService(
      app,
      items,
      { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() },
      () => Promise.resolve(),
      EN_I18N
    );
    alerts.enqueue(fired);
    getCreatedModals()[0]?.close();

    await vi.waitFor(() => expect(items.isAlertReserved(fired.id)).toBe(false));
    expect(items.items[0]).toMatchObject({ id: fired.id, status: "fired" });

    alerts.enqueue(fired);
    expect(getCreatedModals()).toHaveLength(2);
    expect(getCreatedModals()[1]?.isOpen).toBe(true);
  });

  it("closes and releases exactly once when a close-triggered acknowledgement succeeds", async () => {
    const acknowledgement = deferred<boolean>();
    const fired = alarm("closed-success");
    const releaseAlert = vi.fn();
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert,
      acknowledgeFired: vi.fn(() => acknowledgement.promise)
    };
    const alerts = new AlertService(
      app,
      items,
      { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() },
      () => Promise.resolve(),
      EN_I18N
    );
    alerts.enqueue(fired);
    getCreatedModals()[0]?.close();
    acknowledgement.resolve(true);

    await vi.waitFor(() => expect(releaseAlert).toHaveBeenCalledOnce());
    expect(releaseAlert).toHaveBeenCalledWith(fired.id);
  });

  it("ignores a late Stop completion after shutdown without double release", async () => {
    const acknowledgement = deferred<boolean>();
    const fired = alarm("shutdown-late");
    const releaseAlert = vi.fn();
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert,
      acknowledgeFired: vi.fn(() => acknowledgement.promise)
    };
    const alerts = new AlertService(
      app,
      items,
      { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() },
      () => Promise.resolve(),
      EN_I18N
    );
    alerts.enqueue(fired);
    expect(clickMockElementByText(getCreatedModals()[0]?.contentEl, "Stop")).toBe(true);

    alerts.stop();
    acknowledgement.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(releaseAlert).toHaveBeenCalledOnce();
  });

  it("offers Restart and Stop when a timer completes", async () => {
    const fired = timer("repeat-me");
    const releaseAlert = vi.fn();
    const restartFiredTimer = vi.fn(() => Promise.resolve(true));
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert,
      restartFiredTimer
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const alerts = new AlertService(app, items, audio, () => Promise.resolve(), EN_I18N);

    alerts.enqueue(fired);
    const modal = getCreatedModals()[0];
    const texts = getMockElementTexts(modal?.contentEl);
    expect(texts).toContain("Restart");
    expect(texts).toContain("Stop");

    expect(clickMockElementByText(modal?.contentEl, "Restart")).toBe(true);
    await vi.waitFor(() => expect(releaseAlert).toHaveBeenCalledWith(fired.id));

    expect(restartFiredTimer).toHaveBeenCalledWith(fired.id);
    expect(releaseAlert).toHaveBeenCalledWith(fired.id);
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it("disables Stop while Restart is saving and does not race mutations", async () => {
    const repeating = deferred<boolean>();
    const fired = timer("repeat-race");
    const acknowledgeFired = vi.fn(() => Promise.resolve(true));
    const restartFiredTimer = vi.fn(() => repeating.promise);
    const releaseAlert = vi.fn();
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert,
      acknowledgeFired,
      restartFiredTimer
    };
    const alerts = new AlertService(
      app,
      items,
      { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() },
      () => Promise.resolve(),
      EN_I18N
    );
    alerts.enqueue(fired);
    const modal = getCreatedModals()[0];

    expect(clickMockElementByText(modal?.contentEl, "Restart")).toBe(true);
    expect(findElementByText(modal?.contentEl, "Restart")?.disabled).toBe(true);
    expect(findElementByText(modal?.contentEl, "Stop")?.disabled).toBe(true);
    expect(clickMockElementByText(modal?.contentEl, "Stop")).toBe(true);
    expect(restartFiredTimer).toHaveBeenCalledOnce();
    expect(acknowledgeFired).not.toHaveBeenCalled();

    repeating.resolve(true);
    await vi.waitFor(() => expect(releaseAlert).toHaveBeenCalledOnce());
  });

  it("keeps Restart actionable when its fired timer is missing", async () => {
    const fired = timer("repeat-missing");
    const releaseAlert = vi.fn();
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert,
      acknowledgeFired: vi.fn(() => Promise.resolve(true))
    };
    const alerts = new AlertService(
      app,
      items,
      { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() },
      () => Promise.resolve(),
      EN_I18N
    );
    alerts.enqueue(fired);
    const modal = getCreatedModals()[0];

    expect(clickMockElementByText(modal?.contentEl, "Restart")).toBe(true);
    await vi.waitFor(() => expect(getRecordedNotices().map((notice) => notice.message)).toContain(
      "The timer could not be restarted."
    ));

    expect(modal?.isOpen).toBe(true);
    expect(findElementByText(modal?.contentEl, "Restart")?.disabled).toBe(false);
    expect(findElementByText(modal?.contentEl, "Stop")?.disabled).toBe(false);
    expect(releaseAlert).not.toHaveBeenCalled();
  });

  it("keeps a completed timer alert open when Restart cannot be saved", async () => {
    const fired = timer("repeat-failure");
    const releaseAlert = vi.fn();
    const restartFiredTimer = vi.fn(() => Promise.reject(new Error("storage unavailable")));
    const items = {
      settings: { ...DEFAULT_SETTINGS, enableSound: false },
      reserveAlert: vi.fn(() => true),
      releaseAlert,
      restartFiredTimer
    };
    const audio = { play: vi.fn(() => Promise.resolve(true)), stop: vi.fn() };
    const alerts = new AlertService(app, items, audio, () => Promise.resolve(), EN_I18N);

    alerts.enqueue(fired);
    const modal = getCreatedModals()[0];
    expect(clickMockElementByText(modal?.contentEl, "Restart")).toBe(true);
    await vi.waitFor(() => expect(getRecordedNotices().map((notice) => notice.message)).toContain(
      "The timer could not be restarted."
    ));

    expect(modal?.isOpen).toBe(true);
    expect(findElementByText(modal?.contentEl, "Restart")?.disabled).toBe(false);
    expect(findElementByText(modal?.contentEl, "Stop")?.disabled).toBe(false);
    expect(releaseAlert).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
  });
});

describe("AlertModal time format", () => {
  beforeEach(() => {
    resetCreatedModals();
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders alert times using the selected 12- or 24-hour format", () => {
    const item = alarm("format");
    item.targetAt = new Date(2026, 6, 14, 15, 5).getTime();
    const actions = { stop: vi.fn() };
    const twelveHour = new AlertModal(app, item, false, actions, EN_I18N);
    const twentyFourHour = new AlertModal(app, item, true, actions, EN_I18N);

    twelveHour.open();
    twentyFourHour.open();

    expect(getMockElementTexts(twelveHour.contentEl)).toContain(`Scheduled for ${formatDateTime(item.targetAt, false, EN_I18N)}`);
    expect(getMockElementTexts(twentyFourHour.contentEl)).toContain(`Scheduled for ${formatDateTime(item.targetAt, true, EN_I18N)}`);
    expect(formatDateTime(item.targetAt, false, EN_I18N)).not.toBe(formatDateTime(item.targetAt, true, EN_I18N));
  });
});
