import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AlarmTimerPlugin from "../src/main";
import { AlertService } from "../src/services/alert-service";
import { AudioService } from "../src/services/audio-service";
import { ItemService } from "../src/services/item-service";
import { Scheduler } from "../src/services/scheduler";
import { DEFAULT_DATA, type AlarmItem, type TimerItem } from "../src/types";
import {
  executeMockCommand,
  getMockSavedData,
  getCreatedSettings,
  getCreatedModals,
  getMockPluginState,
  getMockWorkspace,
  getRecordedNotices,
  MockApp,
  resetRecordedNotices,
  resetCreatedModals,
  resetCreatedSettings,
  resetMockLanguage,
  setMockLanguage,
  setMockPluginData
} from "./mocks/obsidian";

const manifest: PluginManifest = {
  id: "alarm-timer",
  name: "Alarm and Timer",
  author: "Test",
  version: "1.0.0",
  minAppVersion: "1.8.0",
  description: "Test manifest"
};

function createPlugin(data: unknown = { ...DEFAULT_DATA, settings: { ...DEFAULT_DATA.settings }, items: [] }): AlarmTimerPlugin {
  const app = new MockApp();
  const plugin = new AlarmTimerPlugin(app as unknown as App, manifest);
  setMockPluginData(plugin, data);
  return plugin;
}

describe("AlarmTimerPlugin lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRecordedNotices();
    resetCreatedModals();
    resetCreatedSettings();
    resetMockLanguage();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      clearInterval: globalThis.clearInterval,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      setTimeout: globalThis.setTimeout
    });
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers the public plugin surface and starts one scheduler on layout ready", async () => {
    const plugin = createPlugin();

    await plugin.onload();

    const state = getMockPluginState(plugin);
    expect(state.views).toHaveLength(1);
    expect(state.ribbonIcons).toHaveLength(1);
    expect(state.commands.map((command) => command.id)).toEqual([
      "open-view",
      "set-alarm",
      "start-timer",
      "dismiss-ringing-alert",
      "clear-completed-items",
      "pause-next-active-timer",
      "resume-next-paused-timer",
      "restart-next-timer",
      "cancel-next-scheduled-item"
    ]);
    expect(state.commands.find((command) => command.id === "clear-completed-items")?.name).toBe("Clear history");
    expect(state.commands.slice(0, 3).every((command) => command.callback !== undefined)).toBe(true);
    expect(state.commands.slice(3).every((command) => command.checkCallback !== undefined)).toBe(true);
    expect(state.settingTabs).toHaveLength(1);
    expect(getMockWorkspace(plugin).layoutReadyCallbacks).toHaveLength(1);
    expect(state.registeredIntervals).toHaveLength(0);

    getMockWorkspace(plugin).triggerLayoutReady();

    expect(state.statusBarItems).toHaveLength(1);
    expect(state.registeredIntervals).toHaveLength(1);
    expect(state.registeredDomEvents.map((event) => event.type)).toEqual(["focus", "visibilitychange"]);
  });

  it("uses one Obsidian language consistently for commands, ribbon, view, settings, and status", async () => {
    setMockLanguage("tr-TR");
    const plugin = createPlugin();

    await plugin.onload();

    const state = getMockPluginState(plugin);
    expect(plugin.i18n?.language).toBe("tr");
    expect(state.ribbonIcons[0]?.title).toBe("Alarm ve zamanlayıcıyı aç");
    expect(state.commands.map((command) => command.name)).toEqual([
      "Kenar çubuğunu aç",
      "Alarm kur",
      "Zamanlayıcı başlat",
      "Etkin uyarıyı durdur",
      "Geçmişi temizle",
      "Sıradaki etkin zamanlayıcıyı duraklat",
      "Sıradaki duraklatılmış zamanlayıcıyı devam ettir",
      "Sıradaki zamanlayıcıyı yeniden başlat",
      "Sıradaki planlanmış öğeyi iptal et"
    ]);
    const view = state.views[0]?.creator({}) as { getDisplayText(): string };
    expect(view.getDisplayText()).toBe("Alarm and Timer");
    state.settingTabs[0]?.display();
    expect(getCreatedSettings().map((setting) => setting.name)).toEqual(expect.arrayContaining([
      "Varsayılan zamanlayıcı süresi",
      "Uyarılar",
      "Sistem bildirimleri",
      "Gizlilik"
    ]));
    getMockWorkspace(plugin).triggerLayoutReady();
    expect(state.statusBarItems[0]?.text).toBe("Etkin alarm veya zamanlayıcı yok");

    setMockLanguage("en");
    expect(plugin.i18n?.language).toBe("tr");
  });

  it("stops data producers in order and remains pending until queued writes drain", async () => {
    const stopOrder: string[] = [];
    const schedulerStop = vi.spyOn(Scheduler.prototype, "stop").mockImplementation(() => { stopOrder.push("scheduler"); });
    const alertStop = vi.spyOn(AlertService.prototype, "stop").mockImplementation(() => { stopOrder.push("alerts"); });
    const audioStop = vi.spyOn(AudioService.prototype, "stop").mockImplementation(() => { stopOrder.push("audio"); });
    let resolveDrain: (() => void) | undefined;
    const drain = new Promise<void>((resolve) => { resolveDrain = resolve; });
    const waitForPendingDataWrites = vi.spyOn(ItemService.prototype, "waitForPendingDataWrites").mockImplementation(() => {
      stopOrder.push("drain");
      return drain;
    });
    const plugin = createPlugin();
    await plugin.onload();

    let prepared = false;
    const preparing = plugin.prepareForDataRestore().then(() => { prepared = true; });

    expect(stopOrder).toEqual(["scheduler", "alerts", "audio", "drain"]);
    expect(prepared).toBe(false);
    resolveDrain?.();
    await preparing;

    expect(prepared).toBe(true);
    expect(schedulerStop).toHaveBeenCalledOnce();
    expect(alertStop).toHaveBeenCalledOnce();
    expect(audioStop).toHaveBeenCalledOnce();
    expect(waitForPendingDataWrites).toHaveBeenCalledOnce();
  });

  it("prevents the stopped scheduler from initiating another due-item write", async () => {
    const processDue = vi.spyOn(ItemService.prototype, "processDue").mockResolvedValue({ fired: [], missed: [] });
    const plugin = createPlugin();
    await plugin.onload();
    getMockWorkspace(plugin).triggerLayoutReady();
    await vi.waitFor(() => expect(processDue).toHaveBeenCalledOnce());

    await plugin.prepareForDataRestore();
    processDue.mockClear();
    vi.advanceTimersByTime(5_000);
    for (const event of getMockPluginState(plugin).registeredDomEvents) {
      const dispatched = new Event(event.type);
      if (typeof event.callback === "function") event.callback(dispatched);
      else event.callback.handleEvent(dispatched);
    }
    await Promise.resolve();

    expect(processDue).not.toHaveBeenCalled();
  });

  it("rejects data-restore preparation before the item service is initialized", async () => {
    const plugin = createPlugin();

    await expect(plugin.prepareForDataRestore()).rejects.toThrow("Item service is not initialized.");
  });

  it("executes every registered command action", async () => {
    const plugin = createPlugin();
    const workspace = getMockWorkspace(plugin);
    const leaf = { setViewState: vi.fn(() => Promise.resolve()) };
    workspace.rightLeaf = leaf;
    vi.spyOn(AlertService.prototype, "hasActiveAlert").mockReturnValue(true);
    vi.spyOn(ItemService.prototype, "hasHistory").mockReturnValue(true);
    const dismiss = vi.spyOn(AlertService.prototype, "stopActive");
    const clear = vi.spyOn(ItemService.prototype, "clearCompleted").mockResolvedValue();
    await plugin.onload();
    const commands = getMockPluginState(plugin).commands;
    const invoke = (id: string): void => {
      const command = commands.find((candidate) => candidate.id === id);
      if (command === undefined || !executeMockCommand(command)) {
        throw new Error(`Missing or unavailable command action: ${id}`);
      }
    };

    invoke("open-view");
    await vi.waitFor(() => expect(workspace.revealedLeaves).toEqual([leaf]));
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: "alarm-timer-view", active: true });

    invoke("set-alarm");
    invoke("start-timer");
    expect(getCreatedModals().map((modal) => modal.title)).toEqual(["Set an alarm", "Start a timer"]);

    invoke("dismiss-ringing-alert");
    invoke("clear-completed-items");
    expect(dismiss).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("hides conditional commands when no matching action is available", async () => {
    const plugin = createPlugin();
    const stop = vi.spyOn(AlertService.prototype, "stopActive");
    const clear = vi.spyOn(ItemService.prototype, "clearCompleted");
    const controlNext = vi.spyOn(ItemService.prototype, "controlNextItem");
    await plugin.onload();

    const conditionalCommands = getMockPluginState(plugin).commands.slice(3);
    expect(conditionalCommands).toHaveLength(6);
    expect(conditionalCommands.every((command) => command.checkCallback?.(true) === false)).toBe(true);
    expect(conditionalCommands.every((command) => command.checkCallback?.(false) === false)).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(controlNext).not.toHaveBeenCalled();
  });

  const eligibleTimer: TimerItem = {
    id: "eligible",
    type: "timer",
    label: "",
    createdAt: 1,
    targetAt: 2,
    durationMs: 60_000,
    status: "active"
  };

  it.each([
    [
      "dismiss-ringing-alert",
      () => {
        vi.spyOn(AlertService.prototype, "hasActiveAlert").mockReturnValue(true);
        return vi.spyOn(AlertService.prototype, "stopActive");
      }
    ],
    [
      "clear-completed-items",
      () => {
        vi.spyOn(ItemService.prototype, "hasHistory").mockReturnValue(true);
        return vi.spyOn(ItemService.prototype, "clearCompleted").mockResolvedValue();
      }
    ],
    [
      "pause-next-active-timer",
      () => {
        vi.spyOn(ItemService.prototype, "findNextItem").mockReturnValue(eligibleTimer);
        return vi.spyOn(ItemService.prototype, "controlNextItem").mockResolvedValue(true);
      }
    ],
    [
      "resume-next-paused-timer",
      () => {
        vi.spyOn(ItemService.prototype, "findNextItem").mockReturnValue(eligibleTimer);
        return vi.spyOn(ItemService.prototype, "controlNextItem").mockResolvedValue(true);
      }
    ],
    [
      "restart-next-timer",
      () => {
        vi.spyOn(ItemService.prototype, "findNextItem").mockReturnValue(eligibleTimer);
        return vi.spyOn(ItemService.prototype, "controlNextItem").mockResolvedValue(true);
      }
    ],
    [
      "cancel-next-scheduled-item",
      () => {
        vi.spyOn(ItemService.prototype, "findNextItem").mockReturnValue(eligibleTimer);
        return vi.spyOn(ItemService.prototype, "controlNextItem").mockResolvedValue(true);
      }
    ]
  ] as const)("never performs the %s side effect during the probe phase", async (id, arrange) => {
    const plugin = createPlugin();
    const sideEffect = arrange();
    await plugin.onload();
    const command = getMockPluginState(plugin).commands.find((candidate) => candidate.id === id);
    if (command === undefined) throw new Error(`Missing command: ${id}`);

    expect(command.checkCallback?.(true)).toBe(true);
    expect(sideEffect).not.toHaveBeenCalled();

    expect(executeMockCommand(command)).toBe(true);
    expect(sideEffect).toHaveBeenCalledOnce();
  });

  it.each([
    ["ribbon", (plugin: AlarmTimerPlugin) => getMockPluginState(plugin).ribbonIcons[0]?.callback()],
    ["command", (plugin: AlarmTimerPlugin) => getMockPluginState(plugin).commands.find((command) => command.id === "open-view")?.callback?.()],
    ["status", (plugin: AlarmTimerPlugin) => getMockPluginState(plugin).statusBarItems[0]?.dispatch("click")]
  ])("reports one view-opening failure from the %s action", async (_name, invoke) => {
    const plugin = createPlugin();
    const workspace = getMockWorkspace(plugin);
    workspace.rightLeaf = { setViewState: vi.fn(() => Promise.reject(new Error("workspace failed"))) };
    await plugin.onload();
    workspace.triggerLayoutReady();

    invoke(plugin);

    await vi.waitFor(() => expect(getRecordedNotices()).toEqual([{ message: "The Alarm and Timer view could not be opened." }]));
  });

  it("reports one reveal failure after the view state is set", async () => {
    const plugin = createPlugin();
    const workspace = getMockWorkspace(plugin);
    const leaf = { setViewState: vi.fn(() => Promise.resolve()) };
    workspace.rightLeaf = leaf;
    vi.spyOn(workspace, "revealLeaf").mockRejectedValue(new Error("reveal failed"));
    await plugin.onload();

    getMockPluginState(plugin).ribbonIcons[0]?.callback();

    await vi.waitFor(() => expect(getRecordedNotices()).toEqual([{ message: "The Alarm and Timer view could not be opened." }]));
  });

  it("reports one clear-completed command failure", async () => {
    const plugin = createPlugin();
    vi.spyOn(ItemService.prototype, "hasHistory").mockReturnValue(true);
    vi.spyOn(ItemService.prototype, "clearCompleted").mockRejectedValue(new Error("storage failed"));
    await plugin.onload();

    getMockPluginState(plugin).commands
      .find((command) => command.id === "clear-completed-items")
      ?.checkCallback?.(false);

    await vi.waitFor(() => expect(getRecordedNotices()).toEqual([{ message: "History could not be cleared." }]));
  });

  it("invokes each deterministic next-item command through ItemService", async () => {
    const plugin = createPlugin();
    const eligibleTimer: TimerItem = {
      id: "eligible",
      type: "timer",
      label: "",
      createdAt: 1,
      targetAt: 2,
      durationMs: 60_000,
      status: "active"
    };
    vi.spyOn(ItemService.prototype, "findNextItem").mockReturnValue(eligibleTimer);
    const controlNext = vi.spyOn(ItemService.prototype, "controlNextItem").mockResolvedValue(true);
    await plugin.onload();
    const commands = getMockPluginState(plugin).commands;
    const invoke = (id: string): void => {
      const command = commands.find((candidate) => candidate.id === id);
      if (command !== undefined) executeMockCommand(command);
    };

    invoke("pause-next-active-timer");
    invoke("resume-next-paused-timer");
    invoke("restart-next-timer");
    invoke("cancel-next-scheduled-item");

    await vi.waitFor(() => expect(controlNext).toHaveBeenCalledTimes(4));
    expect(controlNext.mock.calls.map(([action]) => action)).toEqual(["pause", "resume", "restart", "cancel"]);
    expect(getRecordedNotices()).toEqual([]);
  });

  it("reports missing and failed next-item command actions exactly once", async () => {
    const plugin = createPlugin();
    const eligibleTimer: TimerItem = {
      id: "eligible",
      type: "timer",
      label: "",
      createdAt: 1,
      targetAt: 2,
      durationMs: 60_000,
      status: "active"
    };
    vi.spyOn(ItemService.prototype, "findNextItem").mockReturnValue(eligibleTimer);
    const controlNext = vi.spyOn(ItemService.prototype, "controlNextItem")
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("save failed"));
    await plugin.onload();
    const pause = getMockPluginState(plugin).commands
      .find((command) => command.id === "pause-next-active-timer")
      ?.checkCallback;

    pause?.(false);
    pause?.(false);

    await vi.waitFor(() => expect(getRecordedNotices()).toEqual([
      { message: "No active timer is available to pause." },
      { message: "The timer could not be paused." }
    ]));
    expect(controlNext.mock.calls.map(([action]) => action)).toEqual(["pause", "pause"]);
  });

  it("wires system-notification clicks to the existing sidebar opener", async () => {
    const fired: AlarmItem = { id: "notify", type: "alarm", label: "Notification", createdAt: 1, targetAt: 2, status: "fired", firedAt: 3 };
    const plugin = createPlugin({
      ...DEFAULT_DATA,
      settings: { ...DEFAULT_DATA.settings, enableSound: false, enableSystemNotifications: true },
      items: [fired]
    });
    const workspace = getMockWorkspace(plugin);
    const leaf = { setViewState: vi.fn(() => Promise.resolve()) };
    workspace.rightLeaf = leaf;
    const focus = vi.fn();
    Object.assign(window, { focus });
    class TestNotification {
      public static readonly created: TestNotification[] = [];
      public static permission = "granted";
      public readonly close = vi.fn();
      public onclick: (() => void) | null = null;
      public constructor() { TestNotification.created.push(this); }
    }
    vi.stubGlobal("Notification", TestNotification);
    await plugin.onload();

    const alerts = (plugin as unknown as { alerts: AlertService }).alerts;
    alerts.enqueue(fired);
    const createdNotification = TestNotification.created[0];
    createdNotification?.onclick?.();

    await vi.waitFor(() => expect(workspace.revealedLeaves).toEqual([leaf]));
    expect(createdNotification?.close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: "alarm-timer-view", active: true });
  });

  it("stops scheduler, alert, and audio services in order when unloaded", async () => {
    const stopOrder: string[] = [];
    const schedulerStop = vi.spyOn(Scheduler.prototype, "stop").mockImplementation(() => { stopOrder.push("scheduler"); });
    const alertStop = vi.spyOn(AlertService.prototype, "stop").mockImplementation(() => { stopOrder.push("alerts"); });
    const audioStop = vi.spyOn(AudioService.prototype, "stop").mockImplementation(() => { stopOrder.push("audio"); });
    const plugin = createPlugin();
    await plugin.onload();

    plugin.onunload();

    expect(schedulerStop).toHaveBeenCalledOnce();
    expect(alertStop).toHaveBeenCalledOnce();
    expect(audioStop).toHaveBeenCalledOnce();
    expect(stopOrder).toEqual(["scheduler", "alerts", "audio"]);
  });

  it("stops status-bar service and DOM reactions when unloaded", async () => {
    const plugin = createPlugin();
    await plugin.onload();
    getMockWorkspace(plugin).triggerLayoutReady();
    const state = getMockPluginState(plugin);
    const statusBar = state.statusBarItems[0];
    const setText = statusBar === undefined ? undefined : vi.spyOn(statusBar, "setText");
    const openStatusView = vi.spyOn(
      plugin as unknown as { openViewWithFeedback(): void },
      "openViewWithFeedback"
    );
    const items = (plugin as unknown as { items: ItemService }).items;
    setText?.mockClear();

    plugin.onunload();
    items.tick();
    statusBar?.dispatch("click");
    statusBar?.dispatch("keydown", { key: "Enter", preventDefault: vi.fn() } as unknown as KeyboardEvent);

    expect(setText).not.toHaveBeenCalled();
    expect(openStatusView).not.toHaveBeenCalled();
  });

  it("does not start layout-ready UI or scheduling after unload", async () => {
    const plugin = createPlugin();
    await plugin.onload();

    plugin.onunload();
    getMockWorkspace(plugin).triggerLayoutReady();

    expect(getMockPluginState(plugin).statusBarItems).toEqual([]);
    expect(getMockPluginState(plugin).registeredIntervals).toEqual([]);
    expect(getMockPluginState(plugin).registeredDomEvents).toEqual([]);
  });

  it("aborts startup without registration or writes for a future schema", async () => {
    const raw = { schemaVersion: 3, futureSettings: { retained: true }, futureItems: [{ retained: true }] };
    const plugin = createPlugin(raw);

    await plugin.onload();

    const state = getMockPluginState(plugin);
    expect(state.views).toEqual([]);
    expect(state.ribbonIcons).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(state.settingTabs).toEqual([]);
    expect(state.registeredCallbacks).toEqual([]);
    expect(state.registeredIntervals).toEqual([]);
    expect(state.registeredDomEvents).toEqual([]);
    expect(state.statusBarItems).toEqual([]);
    expect(getMockWorkspace(plugin).layoutReadyCallbacks).toEqual([]);
    expect(getMockSavedData(plugin)).toEqual([]);
    expect(raw).toEqual({ schemaVersion: 3, futureSettings: { retained: true }, futureItems: [{ retained: true }] });
    expect(getRecordedNotices()).toHaveLength(1);
    expect(getRecordedNotices()[0]?.message).toContain("Reinstall the latest plugin version");
  });

  it("aborts startup without registration or writes for a malformed schema version", async () => {
    const raw = { schemaVersion: "1", privateSettings: { retained: true }, privateItems: [{ retained: true }] };
    const plugin = createPlugin(raw);

    await plugin.onload();

    const state = getMockPluginState(plugin);
    expect(state.views).toEqual([]);
    expect(state.ribbonIcons).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(state.settingTabs).toEqual([]);
    expect(state.registeredCallbacks).toEqual([]);
    expect(state.registeredIntervals).toEqual([]);
    expect(state.registeredDomEvents).toEqual([]);
    expect(state.statusBarItems).toEqual([]);
    expect(getMockWorkspace(plugin).layoutReadyCallbacks).toEqual([]);
    expect(getMockSavedData(plugin)).toEqual([]);
    expect(raw).toEqual({ schemaVersion: "1", privateSettings: { retained: true }, privateItems: [{ retained: true }] });
    expect(getRecordedNotices()).toEqual([
      { message: "Alarm and timer data has an invalid schema version. Reinstall the latest plugin version before continuing." }
    ]);
  });

  it("continues rejecting unrelated load failures", async () => {
    const plugin = createPlugin();
    vi.spyOn(plugin, "loadData").mockRejectedValue(new Error("storage read failed"));

    await expect(plugin.onload()).rejects.toThrow("storage read failed");

    expect(getMockPluginState(plugin).views).toEqual([]);
    expect(getRecordedNotices()).toEqual([]);
  });
});
