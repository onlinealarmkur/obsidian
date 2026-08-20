import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EN_I18N } from "../src/i18n";
import { ItemService } from "../src/services/item-service";
import type { PluginData, ScheduledItem } from "../src/types";
import { DEFAULT_DATA } from "../src/types";
import { StatusBarController } from "../src/ui/status-bar-controller";
import { MockElement, MockEvent } from "./mocks/obsidian";

function alarm(
  id: string,
  label: string,
  targetAt: number,
  createdAt: number,
  status: "active" | "fired" = "active"
): ScheduledItem {
  return status === "active"
    ? { id, type: "alarm", label, createdAt, targetAt, status }
    : { id, type: "alarm", label, createdAt, targetAt, status, firedAt: targetAt };
}

function createItems(items: ScheduledItem[] = [], showStatusBar = true): ItemService {
  const data: PluginData = {
    ...DEFAULT_DATA,
    settings: { ...DEFAULT_DATA.settings, showStatusBar },
    items
  };
  return new ItemService(data, { save: vi.fn(() => Promise.resolve()) }, EN_I18N);
}

function createController(
  items: ItemService,
  openView = vi.fn()
): { controller: StatusBarController; element: MockElement; openView: ReturnType<typeof vi.fn> } {
  const element = new MockElement();
  const controller = new StatusBarController(element as unknown as HTMLElement, items, EN_I18N, openView);
  return { controller, element, openView };
}

describe("StatusBarController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts with the existing interactive empty state and remains idempotent", () => {
    const items = createItems();
    const subscribe = vi.spyOn(items, "subscribe");
    const { controller, element } = createController(items);

    controller.start();
    controller.start();

    expect(subscribe).toHaveBeenCalledOnce();
    expect(element.classes).toContain("online-alarm-timer-status");
    expect(element.classes).not.toContain("online-alarm-timer-hidden");
    expect(element.getAttribute("role")).toBe("button");
    expect(element.tabIndex).toBe(0);
    expect(element.text).toBe("No active alarms or timers");
    expect(element.getAttribute("aria-label")).toBe("No active alarms or timers");
    expect(element.getAttribute("title")).toBe("No active alarms or timers. Open Alarm and Timer.");
  });

  it("does not render while hidden and reacts to the existing visibility setting", async () => {
    const items = createItems([], false);
    const { controller, element } = createController(items);
    const setText = vi.spyOn(element, "setText");

    controller.start();

    expect(element.classes).toContain("online-alarm-timer-hidden");
    expect(setText).not.toHaveBeenCalled();

    await items.updateSettings({ showStatusBar: true });

    expect(element.classes).not.toContain("online-alarm-timer-hidden");
    expect(element.text).toBe("No active alarms or timers");
  });

  it("uses canonical ordering and refreshes its cached item on data events", async () => {
    const now = Date.now();
    const items = createItems([
      alarm("completed", "Completed", now - 60_000, now - 120_000, "fired"),
      alarm("later-z", "Later Z", now + 120_000, now),
      alarm("later-a", "Later A", now + 120_000, now)
    ]);
    const { controller, element } = createController(items);
    controller.start();

    expect(element.text).toBe("Alarm 02:00");
    expect(element.getAttribute("aria-label")).toBe("Later A, Alarm 02:00");

    await items.addAlarm(now + 30_000, "Sooner");

    expect(element.text).toBe("Alarm 00:30");
    expect(element.getAttribute("aria-label")).toBe("Sooner, Alarm 00:30");
  });

  it("updates countdowns on ticks without rescanning history and preserves long accessible labels", () => {
    const now = Date.now();
    const longLabel = "A very long project checkpoint label that must remain complete for assistive technology";
    const items = createItems([
      alarm("history", "History", now - 60_000, now - 120_000, "fired"),
      alarm("next", longLabel, now + 30_000, now)
    ]);
    const { controller, element } = createController(items);
    controller.start();
    const itemReads = vi.spyOn(items, "items", "get");
    itemReads.mockClear();

    vi.setSystemTime(now + 1_000);
    items.tick();

    expect(itemReads).not.toHaveBeenCalled();
    expect(element.text).toBe("Alarm 00:29");
    expect(element.getAttribute("aria-label")).toBe(`${longLabel}, Alarm 00:29`);
    expect(element.getAttribute("title")).toBe(`${longLabel}, Alarm 00:29. Open Alarm and Timer.`);
  });

  it("opens from click, Enter, and Space while ignoring other keys", () => {
    const items = createItems();
    const { controller, element, openView } = createController(items);
    controller.start();

    const enter = element.dispatch("keydown", new MockEvent("Enter"));
    const space = element.dispatch("keydown", new MockEvent(" "));
    const escape = element.dispatch("keydown", new MockEvent("Escape"));
    element.dispatch("click");

    expect(openView).toHaveBeenCalledTimes(3);
    expect(enter.defaultPrevented).toBe(true);
    expect(space.defaultPrevented).toBe(true);
    expect(escape.defaultPrevented).toBe(false);
  });

  it("stops idempotently and ignores service and DOM events after stop", async () => {
    const items = createItems();
    const { controller, element, openView } = createController(items);
    controller.start();
    const setText = vi.spyOn(element, "setText");
    const toggleClass = vi.spyOn(element, "toggleClass");
    setText.mockClear();
    toggleClass.mockClear();

    controller.stop();
    controller.stop();
    items.tick();
    await items.addAlarm(Date.now() + 60_000, "After stop");
    element.dispatch("click");
    element.dispatch("keydown", new MockEvent("Enter"));

    expect(setText).not.toHaveBeenCalled();
    expect(toggleClass).not.toHaveBeenCalled();
    expect(openView).not.toHaveBeenCalled();
  });

  it("can restart after stop without duplicating DOM or service reactions", () => {
    const items = createItems();
    const subscribe = vi.spyOn(items, "subscribe");
    const { controller, element, openView } = createController(items);

    controller.start();
    controller.stop();
    controller.start();
    element.dispatch("click");
    element.dispatch("keydown", new MockEvent("Enter"));

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(openView).toHaveBeenCalledTimes(2);
    expect(element.text).toBe("No active alarms or timers");
  });
});
