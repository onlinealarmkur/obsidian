import type { WorkspaceLeaf } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EN_I18N } from "../src/i18n";
import { ItemService } from "../src/services/item-service";
import { AlarmTimerView } from "../src/ui/alarm-timer-view";
import { DEFAULT_SETTINGS, type AlarmItem, type PluginData, type TimerItem } from "../src/types";
import {
  dispatchMockKeyboardById,
  clickMockElementByText,
  findMockElementByClass,
  findMockElementById,
  getCreatedModals,
  getRecordedNotices,
  getMockElementTexts,
  resetCreatedModals,
  resetRecordedNotices,
  type MockElement
} from "./mocks/obsidian";

function requireElement(element: MockElement | undefined, description: string): MockElement {
  if (element === undefined) throw new Error(`Missing mock element: ${description}`);
  return element;
}

function findElementsByClass(root: MockElement, className: string): MockElement[] {
  return [
    ...(root.classes.has(className) ? [root] : []),
    ...root.children.flatMap((child) => findElementsByClass(child, className))
  ];
}

function findElementsByTag(root: MockElement, tagName: string): MockElement[] {
  return [
    ...(root.tagName === tagName ? [root] : []),
    ...root.children.flatMap((child) => findElementsByTag(child, tagName))
  ];
}

function createItems(item?: TimerItem): ItemService {
  const timer: TimerItem = item ?? {
    id: "timer",
    type: "timer",
    label: "Tea",
    createdAt: Date.now(),
    targetAt: Date.now() + 60_000,
    status: "active",
    durationMs: 60_000
  };
  const data: PluginData = {
    schemaVersion: 1,
    settings: { ...DEFAULT_SETTINGS },
    items: [timer]
  };
  return new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
}

function scheduledTimer(
  id: string,
  label: string,
  status: TimerItem["status"],
  targetAt: number,
  createdAt = targetAt
): TimerItem {
  const base = { id, type: "timer" as const, label, createdAt, targetAt, status, durationMs: 60_000 };
  return status === "paused" ? { ...base, status, remainingMs: 30_000 } : { ...base, status };
}

describe("AlarmTimerView", () => {
  beforeEach(() => {
    resetCreatedModals();
    resetRecordedNotices();
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves form input and shell nodes across data and tick events", async () => {
    const items = createItems();
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();

    const content = view.contentEl;
    const labelInput = requireElement(findMockElementById(content, "online-alarm-timer-view-alarm-label"), "alarm label input");
    const panel = requireElement(findMockElementById(content, "online-alarm-timer-schedule-panel"), "tab panel");
    const activeHost = requireElement(findMockElementById(content, "online-alarm-timer-active-items"), "active items host");
    const firstRemaining = requireElement(findMockElementByClass(content, "online-alarm-timer-remaining"), "remaining text");
    labelInput.value = "Unsaved draft";

    await items.updateSettings({ volume: 71 });

    expect(findMockElementById(content, "online-alarm-timer-view-alarm-label")).toBe(labelInput);
    expect(labelInput.value).toBe("Unsaved draft");
    expect(findMockElementById(content, "online-alarm-timer-schedule-panel")).toBe(panel);
    expect(findMockElementById(content, "online-alarm-timer-active-items")).toBe(activeHost);
    const refreshedRemaining = requireElement(findMockElementByClass(content, "online-alarm-timer-remaining"), "refreshed remaining text");
    expect(refreshedRemaining).not.toBe(firstRemaining);

    items.tick();

    expect(findMockElementByClass(content, "online-alarm-timer-remaining")).toBe(refreshedRemaining);
    expect(findMockElementById(content, "online-alarm-timer-view-alarm-label")).toBe(labelInput);
    expect(findMockElementById(content, "online-alarm-timer-active-items")).toBe(activeHost);
    expect(refreshedRemaining.text).toMatch(/^In /);
    await view.onClose();
  });

  it("updates only rendered active entries on ticks and clears them on close", async () => {
    const now = Date.now();
    const active: TimerItem = {
      id: "active",
      type: "timer",
      label: "Active",
      createdAt: now,
      targetAt: now + 60_000,
      status: "active",
      durationMs: 60_000
    };
    const paused: TimerItem = {
      id: "paused",
      type: "timer",
      label: "Paused",
      createdAt: now,
      targetAt: now + 30_000,
      status: "paused",
      durationMs: 60_000,
      remainingMs: 30_000
    };
    const completed = Array.from({ length: 500 }, (_, index): TimerItem => ({
      id: `completed-${index}`,
      type: "timer",
      label: `Completed ${index}`,
      createdAt: now - 120_000 - index,
      targetAt: now - 60_000 - index,
      status: "completed",
      firedAt: now - 60_000 - index,
      completedAt: now - 60_000 - index,
      durationMs: 60_000
    }));
    const data: PluginData = {
      schemaVersion: 1,
      settings: { ...DEFAULT_SETTINGS },
      items: [active, paused, ...completed]
    };
    const items = new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();
    const remaining = findElementsByClass(view.contentEl as unknown as MockElement, "online-alarm-timer-remaining");

    expect(remaining).toHaveLength(2);
    expect(getMockElementTexts(view.contentEl)).toContain("00:30 remaining");
    const itemReads = vi.spyOn(items, "items", "get");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firstCompleted = completed[0];
    if (firstCompleted === undefined) throw new Error("Missing completed fixture");
    Object.defineProperty(firstCompleted, "status", {
      configurable: true,
      get: () => { throw new Error("completed item was visited during tick"); }
    });
    const updates = remaining.map((element) => vi.spyOn(element, "setText"));

    items.tick();

    expect(itemReads).not.toHaveBeenCalled();
    expect(diagnostic).not.toHaveBeenCalled();
    for (const update of updates) expect(update).toHaveBeenCalledOnce();

    await view.onClose();
    for (const update of updates) update.mockClear();
    items.tick();
    for (const update of updates) expect(update).not.toHaveBeenCalled();
  });

  it("orders active cards by target, creation, and ID without changing completed order", async () => {
    const now = Date.now();
    const sharedTargetAt = now + 120_000;
    const activeItems: TimerItem[] = [
      {
        id: "created-later",
        type: "timer",
        label: "Later creation",
        createdAt: now - 10_000,
        targetAt: sharedTargetAt,
        status: "active",
        durationMs: 120_000
      },
      {
        id: "same-created-b",
        type: "timer",
        label: "ID B",
        createdAt: now - 20_000,
        targetAt: sharedTargetAt,
        status: "active",
        durationMs: 120_000
      },
      {
        id: "same-created-a",
        type: "timer",
        label: "ID A",
        createdAt: now - 20_000,
        targetAt: sharedTargetAt,
        status: "active",
        durationMs: 120_000
      },
      {
        id: "earlier-paused",
        type: "timer",
        label: "Earlier target",
        createdAt: now - 5_000,
        targetAt: now + 60_000,
        status: "paused",
        durationMs: 120_000,
        remainingMs: 60_000
      }
    ];
    const completedItems: TimerItem[] = [
      {
        id: "older-completed",
        type: "timer",
        label: "Older completed",
        createdAt: now - 240_000,
        targetAt: now - 120_000,
        status: "completed",
        firedAt: now - 120_000,
        completedAt: now - 120_000,
        durationMs: 120_000
      },
      {
        id: "newer-completed",
        type: "timer",
        label: "Newer completed",
        createdAt: now - 180_000,
        targetAt: now - 60_000,
        status: "completed",
        firedAt: now - 60_000,
        completedAt: now - 60_000,
        durationMs: 120_000
      }
    ];
    const data: PluginData = {
      schemaVersion: 1,
      settings: { ...DEFAULT_SETTINGS },
      items: [...activeItems, ...completedItems]
    };
    const items = new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);

    await view.onOpen();

    const activeHost = requireElement(
      findMockElementById(view.contentEl, "online-alarm-timer-active-items"),
      "active items host"
    );
    const completedHost = requireElement(
      findMockElementById(view.contentEl, "online-alarm-timer-completed-items"),
      "completed items host"
    );
    const activeLabels = findElementsByClass(activeHost, "online-alarm-timer-card")
      .map((card) => getMockElementTexts(card)[0]);
    const completedLabels = findElementsByClass(completedHost, "online-alarm-timer-card")
      .map((card) => getMockElementTexts(card)[0]);

    expect(activeLabels).toEqual(["Earlier target", "ID A", "ID B", "Later creation"]);
    expect(completedLabels).toEqual(["Newer completed", "Older completed"]);
    await view.onClose();
  });

  it("links tabs to their panel and supports arrow-key selection", async () => {
    const view = new AlarmTimerView({} as WorkspaceLeaf, createItems(), EN_I18N);
    await view.onOpen();
    const content = view.contentEl;
    const alarmTab = requireElement(findMockElementById(content, "online-alarm-timer-alarm-tab"), "alarm tab");
    const timerTab = requireElement(findMockElementById(content, "online-alarm-timer-timer-tab"), "timer tab");
    const panel = requireElement(findMockElementById(content, "online-alarm-timer-schedule-panel"), "tab panel");
    const alarmForm = requireElement(findMockElementById(content, "online-alarm-timer-view-alarm-label"), "alarm form input");

    expect(alarmTab.getAttribute("role")).toBe("tab");
    expect(alarmTab.getAttribute("aria-controls")).toBe("online-alarm-timer-schedule-panel");
    expect(alarmTab.getAttribute("aria-selected")).toBe("true");
    expect(alarmTab.tabIndex).toBe(0);
    expect(timerTab.getAttribute("aria-selected")).toBe("false");
    expect(timerTab.tabIndex).toBe(-1);
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe("online-alarm-timer-alarm-tab");

    const event = dispatchMockKeyboardById(content, "online-alarm-timer-alarm-tab", "ArrowRight");

    expect(event?.defaultPrevented).toBe(true);
    expect(alarmTab.getAttribute("aria-selected")).toBe("false");
    expect(alarmTab.tabIndex).toBe(-1);
    expect(timerTab.getAttribute("aria-selected")).toBe("true");
    expect(timerTab.tabIndex).toBe(0);
    expect(timerTab.focused).toBe(true);
    expect(panel.getAttribute("aria-labelledby")).toBe("online-alarm-timer-timer-tab");
    expect(findMockElementById(content, "online-alarm-timer-view-alarm-label")).toBeUndefined();
    expect(findMockElementById(content, "online-alarm-timer-view-timer-duration")).toBeDefined();
    expect(findMockElementById(content, "online-alarm-timer-view-alarm-label")).not.toBe(alarmForm);
    await view.onClose();
  });

  it("gives repeated item controls unique accessible names", async () => {
    const now = Date.now();
    const data: PluginData = {
      schemaVersion: 1,
      settings: { ...DEFAULT_SETTINGS },
      items: [
        {
          id: "tea",
          type: "timer",
          label: "Tea",
          createdAt: now,
          targetAt: now + 60_000,
          status: "active",
          durationMs: 60_000
        },
        {
          id: "coffee",
          type: "timer",
          label: "Coffee",
          createdAt: now + 1,
          targetAt: now + 120_000,
          status: "active",
          durationMs: 120_000
        }
      ]
    };
    const view = new AlarmTimerView(
      {} as WorkspaceLeaf,
      new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N),
      EN_I18N
    );

    await view.onOpen();

    const cards = findElementsByClass(view.contentEl as unknown as MockElement, "online-alarm-timer-card");
    expect(cards.map((card) => [card.getAttribute("role"), card.getAttribute("aria-label")])).toEqual([
      ["group", "Tea timer"],
      ["group", "Coffee timer"]
    ]);
    const actionLabels = findElementsByTag(view.contentEl as unknown as MockElement, "button")
      .filter((button) => ["Pause", "Restart", "Cancel"].includes(button.text))
      .map((button) => button.getAttribute("aria-label"));
    expect(actionLabels).toEqual([
      "Pause Tea timer",
      "Restart Tea timer",
      "Cancel Tea timer",
      "Pause Coffee timer",
      "Restart Coffee timer",
      "Cancel Coffee timer"
    ]);
    await view.onClose();
  });

  it("distinguishes blank and duplicate active item names across every action", async () => {
    const now = Date.now();
    const data: PluginData = {
      schemaVersion: 1,
      settings: { ...DEFAULT_SETTINGS },
      items: [
        scheduledTimer("tea-active-2", "Tea", "active", now + 60_000),
        scheduledTimer("blank-paused-2", "", "paused", now + 40_000),
        scheduledTimer("blank-active-1", "", "active", now + 10_000),
        scheduledTimer("tea-active-1", "Tea", "active", now + 50_000),
        scheduledTimer("blank-paused-1", "", "paused", now + 30_000),
        scheduledTimer("blank-active-2", "", "active", now + 20_000)
      ]
    };
    const view = new AlarmTimerView(
      {} as WorkspaceLeaf,
      new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N),
      EN_I18N
    );

    await view.onOpen();

    const activeHost = requireElement(
      findMockElementById(view.contentEl, "online-alarm-timer-active-items"),
      "active items host"
    );
    const cards = findElementsByClass(activeHost, "online-alarm-timer-card");
    const cardNames = cards.map((card) => card.getAttribute("aria-label"));
    expect(cards.map((card) => card.getAttribute("role"))).toEqual(["group", "group", "group", "group", "group", "group"]);
    expect(cardNames).toEqual([
      "timer, item 1 of 4",
      "timer, item 2 of 4",
      "timer, item 3 of 4",
      "timer, item 4 of 4",
      "Tea timer, item 1 of 2",
      "Tea timer, item 2 of 2"
    ]);

    const buttons = findElementsByTag(activeHost, "button");
    for (const action of ["Pause", "Resume", "Restart", "Cancel"]) {
      const names = buttons.filter((button) => button.text === action).map((button) => button.getAttribute("aria-label"));
      expect(names.length).toBeGreaterThan(1);
      expect(names.every((name) => name !== undefined)).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    }
    const actionNames = buttons.map((button) => button.getAttribute("aria-label"));
    expect(actionNames).toEqual(expect.arrayContaining([
      "Pause timer, item 2 of 4",
      "Resume timer, item 4 of 4",
      "Restart timer, item 3 of 4",
      "Cancel Tea timer, item 1 of 2"
    ]));
    expect(actionNames.join(" ")).not.toContain("blank-active-1");
    expect(actionNames.join(" ")).not.toContain(String(now));
    await view.onClose();
  });

  it("distinguishes duplicate terminal timer cards and restart controls", async () => {
    const now = Date.now();
    const data: PluginData = {
      schemaVersion: 1,
      settings: { ...DEFAULT_SETTINGS },
      items: [
        scheduledTimer("blank-active-cross-section", "", "active", now + 10_000),
        scheduledTimer("tea-active-cross-section", "Tea", "active", now + 20_000),
        scheduledTimer("tea-terminal-old", "Tea", "cancelled", now - 40_000),
        scheduledTimer("blank-terminal-old", "", "missed", now - 20_000),
        scheduledTimer("tea-terminal-new", "Tea", "completed", now - 30_000),
        scheduledTimer("blank-terminal-new", "", "completed", now - 10_000)
      ]
    };
    const view = new AlarmTimerView(
      {} as WorkspaceLeaf,
      new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N),
      EN_I18N
    );

    await view.onOpen();

    const activeHost = requireElement(
      findMockElementById(view.contentEl, "online-alarm-timer-active-items"),
      "active items host"
    );
    const completedHost = requireElement(
      findMockElementById(view.contentEl, "online-alarm-timer-completed-items"),
      "completed items host"
    );
    expect(findElementsByClass(activeHost, "online-alarm-timer-card").map((card) => card.getAttribute("aria-label"))).toEqual([
      "timer",
      "Tea timer"
    ]);
    const cards = findElementsByClass(completedHost, "online-alarm-timer-card");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "timer, item 1 of 2",
      "timer, item 2 of 2",
      "Tea timer, item 1 of 2",
      "Tea timer, item 2 of 2"
    ]);
    const restartNames = findElementsByTag(completedHost, "button")
      .filter((button) => button.text === "Restart")
      .map((button) => button.getAttribute("aria-label"));
    expect(restartNames).toEqual([
      "Restart timer, item 1 of 2",
      "Restart timer, item 2 of 2",
      "Restart Tea timer, item 1 of 2",
      "Restart Tea timer, item 2 of 2"
    ]);
    expect(new Set(restartNames).size).toBe(restartNames.length);
    expect(restartNames.join(" ")).not.toContain("terminal-new");
    expect(restartNames.join(" ")).not.toContain(String(now));
    await view.onClose();
  });

  it("renders a pending fired timer as Active and Alerting without history controls", async () => {
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
    const items = createItems(firedTimer);
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();
    const activeHost = requireElement(
      findMockElementById(view.contentEl, "online-alarm-timer-active-items"),
      "active items host"
    );
    const completedHost = requireElement(findMockElementById(
      view.contentEl,
      "online-alarm-timer-completed-items"
    ), "completed items host");

    expect(getMockElementTexts(activeHost)).toContain("Alerting");
    expect(getMockElementTexts(activeHost)).not.toContain("Restart");
    expect(getMockElementTexts(activeHost)).not.toContain("Cancel");
    expect(getMockElementTexts(completedHost)).toEqual(["History", "No history yet."]);
    await view.onClose();
  });

  it("renders terminal items under History and clears them", async () => {
    const data: PluginData = {
      schemaVersion: 1,
      settings: { ...DEFAULT_SETTINGS },
      items: [
        scheduledTimer("cancelled-history", "Cancelled timer", "cancelled", 1),
        scheduledTimer("missed-history", "Missed timer", "missed", 2),
        scheduledTimer("completed-history", "Completed timer", "completed", 3)
      ]
    };
    const items = new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
    const clearHistory = vi.spyOn(items, "clearCompleted");
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();
    const completedHost = requireElement(
      findMockElementById(view.contentEl, "online-alarm-timer-completed-items"),
      "completed items host"
    );

    expect(findElementsByTag(completedHost, "h3").map((heading) => heading.text)).toEqual(["History"]);
    expect(findElementsByTag(completedHost, "button").filter((button) => button.text === "Clear history")).toHaveLength(1);
    expect(findElementsByClass(completedHost, "online-alarm-timer-card").map((card) => getMockElementTexts(card).slice(0, 2))).toEqual([
      ["Completed timer", "Completed"],
      ["Missed timer", "Missed"],
      ["Cancelled timer", "Cancelled"]
    ]);

    expect(clickMockElementByText(completedHost, "Clear history")).toBe(true);

    await vi.waitFor(() => expect(items.items).toEqual([]));
    expect(clearHistory).toHaveBeenCalledOnce();
    expect(getMockElementTexts(completedHost)).toEqual(["History", "No history yet."]);
    expect(findElementsByTag(completedHost, "h3")[0]?.focused).toBe(true);
    await view.onClose();
  });

  it("reveals retained history in stable pages of 50 and resets on reopen without tick rerenders", async () => {
    const history = Array.from({ length: 125 }, (_, index): TimerItem => ({
      id: `history-${index.toString().padStart(3, "0")}`,
      type: "timer",
      label: `Record ${index}`,
      createdAt: index,
      targetAt: index,
      status: "completed",
      firedAt: index,
      completedAt: index,
      durationMs: 60_000
    }));
    const data: PluginData = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS }, items: history };
    const items = new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();
    const historyHost = (): MockElement => requireElement(
      findMockElementById(view.contentEl, "online-alarm-timer-completed-items"),
      "completed items host"
    );
    const cards = (): MockElement[] => findElementsByClass(historyHost(), "online-alarm-timer-card");

    expect(cards()).toHaveLength(50);
    expect(getMockElementTexts(cards()[0])).toContain("Record 124");
    expect(getMockElementTexts(cards()[49])).toContain("Record 75");
    expect(getMockElementTexts(historyHost())).toContain("Show more");
    const firstCard = cards()[0];

    items.tick();
    expect(cards()[0]).toBe(firstCard);

    expect(clickMockElementByText(historyHost(), "Show more")).toBe(true);
    expect(cards()).toHaveLength(100);
    expect(getMockElementTexts(cards()[99])).toContain("Record 25");
    expect(getMockElementTexts(historyHost())).toContain("Show more");

    expect(clickMockElementByText(historyHost(), "Show more")).toBe(true);
    expect(cards()).toHaveLength(125);
    expect(getMockElementTexts(cards()[124])).toContain("Record 0");
    expect(getMockElementTexts(historyHost())).not.toContain("Show more");
    expect(findElementsByTag(historyHost(), "h3")[0]?.focused).toBe(true);
    expect(items.items).toHaveLength(125);

    await view.onClose();
    await view.onOpen();
    expect(cards()).toHaveLength(50);
    await view.onClose();
  });

  it("opens a prefilled editor for an active alarm and closes after a successful save", async () => {
    const targetAt = Date.now() + 3_600_000;
    const alarm: AlarmItem = {
      id: "alarm",
      type: "alarm",
      label: "Meeting",
      createdAt: Date.now(),
      targetAt,
      status: "active",
    };
    const items = new ItemService(
      { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS }, items: [alarm] },
      { save: vi.fn(() => Promise.resolve()) },
      EN_I18N
    );
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();

    expect(getMockElementTexts(view.contentEl)).toContain("Edit");
    expect(clickMockElementByText(view.contentEl, "Edit")).toBe(true);
    const modal = getCreatedModals()[0];
    expect(modal?.title).toBe("Edit alarm");
    const label = requireElement(findMockElementById(modal?.contentEl, "online-alarm-timer-edit-alarm-label"), "modal label");
    expect(label.value).toBe("Meeting");
    label.value = "Edited meeting";

    modal?.contentEl.children[0]?.dispatch("submit");

    await vi.waitFor(() => expect(modal?.isOpen).toBe(false));
    expect(items.items[0]).toMatchObject({ label: "Edited meeting", targetAt, status: "active" });
    await view.onClose();
  });

  it("does not offer edit while the active item is reserved", async () => {
    const alarm: AlarmItem = {
      id: "reserved-alarm",
      type: "alarm",
      label: "Meeting",
      createdAt: Date.now(),
      targetAt: Date.now() + 60_000,
      status: "active",
    };
    const items = new ItemService(
      { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS }, items: [alarm] },
      { save: vi.fn(() => Promise.resolve()) },
      EN_I18N
    );
    vi.spyOn(items, "isAlertReserved").mockReturnValue(true);
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);

    await view.onOpen();

    expect(getMockElementTexts(view.contentEl)).not.toContain("Edit");
    await view.onClose();
  });

  it("wires timer controls through pause, resume, restart, cancel, and completed restart", async () => {
    const now = Date.now();
    const items = createItems({
      id: "timer",
      type: "timer",
      label: "Tea",
      createdAt: now,
      targetAt: now + 60_000,
      status: "active",
      durationMs: 120_000
    });
    const pause = vi.spyOn(items, "pauseTimer");
    const resume = vi.spyOn(items, "resumeTimer");
    const restart = vi.spyOn(items, "restartTimer");
    const cancel = vi.spyOn(items, "cancel");
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();

    expect(clickMockElementByText(view.contentEl, "Restart")).toBe(true);
    await vi.waitFor(() => expect(items.items[0]?.targetAt).toBeGreaterThan(now + 110_000));
    expect(restart).toHaveBeenCalledWith("timer");

    expect(clickMockElementByText(view.contentEl, "Pause")).toBe(true);
    await vi.waitFor(() => expect(items.items[0]?.status).toBe("paused"));
    expect(pause).toHaveBeenCalledWith("timer");
    expect(getMockElementTexts(view.contentEl)).toContain("Resume");

    expect(clickMockElementByText(view.contentEl, "Resume")).toBe(true);
    await vi.waitFor(() => expect(items.items[0]?.status).toBe("active"));
    expect(resume).toHaveBeenCalledWith("timer");

    expect(clickMockElementByText(view.contentEl, "Cancel")).toBe(true);
    await vi.waitFor(() => expect(items.items[0]?.status).toBe("cancelled"));
    expect(cancel).toHaveBeenCalledWith("timer");
    expect(getMockElementTexts(view.contentEl)).toContain("Cancelled");

    restart.mockClear();
    expect(clickMockElementByText(view.contentEl, "Restart")).toBe(true);
    await vi.waitFor(() => expect(items.items[0]?.status).toBe("active"));
    expect(restart).toHaveBeenCalledWith("timer");
    expect(getMockElementTexts(view.contentEl)).toContain("Pause");
    await view.onClose();
  });

  it("moves focus to History when a cancelled alarm has no replacement action", async () => {
    const now = Date.now();
    const alarm: AlarmItem = {
      id: "alarm-to-cancel",
      type: "alarm",
      label: "Appointment",
      createdAt: now,
      targetAt: now + 60_000,
      status: "active"
    };
    const items = new ItemService(
      { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS }, items: [alarm] },
      { save: vi.fn(() => Promise.resolve()) },
      EN_I18N
    );
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();

    expect(clickMockElementByText(view.contentEl, "Cancel")).toBe(true);

    await vi.waitFor(() => expect(items.items[0]?.status).toBe("cancelled"));
    const completedHost = requireElement(
      findMockElementById(view.contentEl, "online-alarm-timer-completed-items"),
      "completed items host"
    );
    await vi.waitFor(() => expect(findElementsByTag(completedHost, "h3")[0]?.focused).toBe(true));
    await view.onClose();
  });

  it("reports an item-action failure without changing the rendered timer", async () => {
    const items = createItems();
    vi.spyOn(items, "pauseTimer").mockRejectedValue(new Error("storage failed"));
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();

    expect(clickMockElementByText(view.contentEl, "Pause")).toBe(true);

    await vi.waitFor(() => expect(getRecordedNotices()).toEqual([{ message: "The item could not be updated." }]));
    expect(items.items[0]?.status).toBe("active");
    expect(getMockElementTexts(view.contentEl)).toContain("Pause");
    await view.onClose();
  });

  it("reports one clear-history failure", async () => {
    const firedTimer: TimerItem = {
      id: "completed-timer",
      type: "timer",
      label: "Tea",
      createdAt: 1,
      targetAt: 2,
      status: "completed",
      firedAt: 3,
      completedAt: 3,
      durationMs: 60_000
    };
    const items = createItems(firedTimer);
    vi.spyOn(items, "clearCompleted").mockRejectedValue(new Error("storage failed"));
    const view = new AlarmTimerView({} as WorkspaceLeaf, items, EN_I18N);
    await view.onOpen();

    expect(clickMockElementByText(view.contentEl, "Clear history")).toBe(true);

    await vi.waitFor(() => expect(getRecordedNotices()).toEqual([{ message: "History could not be cleared." }]));
    await view.onClose();
  });
});
