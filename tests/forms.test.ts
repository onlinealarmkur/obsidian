import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LABEL_LENGTH } from "../src/constants";
import { createI18n, EN_I18N } from "../src/i18n";
import type { ItemService } from "../src/services/item-service";
import { DEFAULT_SETTINGS, type AlarmItem } from "../src/types";
import { createAlarmForm, createEditAlarmForm, createTimerForm } from "../src/ui/forms";
import { findMockElementByClass, findMockElementById, MockElement } from "./mocks/obsidian";

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let rejectPromise: ((reason: unknown) => void) | undefined;
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject: (reason) => rejectPromise?.(reason),
    resolve: (value) => resolvePromise?.(value)
  };
}

function requireElement(element: MockElement | undefined, description: string): MockElement {
  if (element === undefined) throw new Error(`Missing mock element: ${description}`);
  return element;
}

function tomorrowDateInput(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const year = String(tomorrow.getFullYear());
  const month = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const day = String(tomorrow.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduling forms", () => {
  it("ignores duplicate alarm submits while persistence is pending", async () => {
    const saving = deferred<unknown>();
    const addAlarm = vi.fn((_targetAt: number, _label: string) => saving.promise);
    const items = { settings: { ...DEFAULT_SETTINGS }, addAlarm } as unknown as ItemService;
    const onSuccess = vi.fn();
    const form = createAlarmForm(new MockElement() as unknown as HTMLElement, items, "alarm", onSuccess, EN_I18N) as unknown as MockElement;
    requireElement(findMockElementById(form, "alarm-time"), "alarm time").value = "13:00";
    requireElement(findMockElementById(form, "alarm-date"), "alarm date").value = tomorrowDateInput();
    const submit = requireElement(findMockElementByClass(form, "mod-cta"), "alarm submit");

    form.dispatch("submit");
    form.dispatch("submit");

    expect(addAlarm).toHaveBeenCalledOnce();
    expect(submit.disabled).toBe(true);
    saving.resolve(undefined);
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("ignores duplicate timer submits while persistence is pending", async () => {
    const saving = deferred<unknown>();
    const addTimer = vi.fn((_durationMs: number, _label: string) => saving.promise);
    const items = { settings: { ...DEFAULT_SETTINGS }, addTimer } as unknown as ItemService;
    const form = createTimerForm(new MockElement() as unknown as HTMLElement, items, "timer", vi.fn(), EN_I18N) as unknown as MockElement;
    const submit = requireElement(findMockElementByClass(form, "mod-cta"), "timer submit");

    form.dispatch("submit");
    form.dispatch("submit");

    expect(addTimer).toHaveBeenCalledOnce();
    expect(submit.disabled).toBe(true);
    saving.resolve(undefined);
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
  });

  it("renders the default quick timer buttons in order", () => {
    const items = { settings: { ...DEFAULT_SETTINGS }, addTimer: vi.fn() } as unknown as ItemService;
    const form = createTimerForm(new MockElement() as unknown as HTMLElement, items, "defaults", vi.fn(), EN_I18N) as unknown as MockElement;
    const quick = requireElement(findMockElementByClass(form, "online-alarm-timer-quick"), "quick durations");

    expect(quick.children.map((button) => button.text)).toEqual(["1m", "5m", "10m", "15m", "30m", "60m"]);
  });

  it("sets the shared label length limit on every scheduling form", () => {
    const items = {
      settings: { ...DEFAULT_SETTINGS },
      addAlarm: vi.fn(),
      addTimer: vi.fn(),
      updateAlarm: vi.fn()
    } as unknown as ItemService;
    const alarm: AlarmItem = {
      id: "alarm",
      type: "alarm",
      label: "Meeting",
      createdAt: 1,
      targetAt: Date.now() + 60_000,
      status: "active",
    };
    const alarmCreateForm = createAlarmForm(new MockElement() as unknown as HTMLElement, items, "alarm-create", vi.fn(), EN_I18N);
    const timerCreateForm = createTimerForm(new MockElement() as unknown as HTMLElement, items, "timer-create", vi.fn(), EN_I18N);
    const alarmEditForm = createEditAlarmForm(new MockElement() as unknown as HTMLElement, items, alarm, "alarm-edit", vi.fn(), EN_I18N);
    const labels = [
      requireElement(findMockElementById(alarmCreateForm, "alarm-create-label"), "alarm create label"),
      requireElement(findMockElementById(timerCreateForm, "timer-create-label"), "timer create label"),
      requireElement(findMockElementById(alarmEditForm, "alarm-edit-label"), "alarm edit label")
    ];

    expect(MAX_LABEL_LENGTH).toBe(200);
    expect(labels.map((label) => label.maxLength)).toEqual([
      MAX_LABEL_LENGTH,
      MAX_LABEL_LENGTH,
      MAX_LABEL_LENGTH
    ]);
  });

  it("renders configured quick timer buttons with preserved order and behavior", () => {
    const settings = { ...DEFAULT_SETTINGS, quickTimerMinutes: [25, 2, 90] };
    const items = { settings, addTimer: vi.fn() } as unknown as ItemService;
    const form = createTimerForm(new MockElement() as unknown as HTMLElement, items, "custom", vi.fn(), EN_I18N) as unknown as MockElement;
    const duration = requireElement(findMockElementById(form, "custom-duration"), "timer duration");
    const quick = requireElement(findMockElementByClass(form, "online-alarm-timer-quick"), "quick durations");

    expect(quick.getAttribute("role")).toBe("group");
    expect(quick.getAttribute("aria-label")).toBe("Quick durations");
    expect(quick.children.map((button) => button.text)).toEqual(["25m", "2m", "90m"]);
    expect(quick.children.map((button) => button.type)).toEqual(["button", "button", "button"]);
    expect(quick.children.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Use 25 minute duration",
      "Use 2 minute duration",
      "Use 90 minute duration"
    ]);

    quick.children[1]?.dispatch("click");

    expect(duration.value).toBe("2m");
    expect(duration.focused).toBe(true);
  });

  it.each([
    ["", "Bir süre girin."],
    ["hello", "90s, 10m, 1h 30m, 01:30 veya 01:30:00 gibi değerler kullanın."],
    ["0s", "Süre en az bir saniye olmalıdır."],
    ["721h", "Süre 30 günü geçemez."]
  ])("localizes the timer validation for %j", (input, expected) => {
    const addTimer = vi.fn();
    const items = { settings: { ...DEFAULT_SETTINGS }, addTimer } as unknown as ItemService;
    const form = createTimerForm(
      new MockElement() as unknown as HTMLElement,
      items,
      "localized",
      vi.fn(),
      createI18n("tr")
    ) as unknown as MockElement;
    const duration = requireElement(findMockElementById(form, "localized-duration"), "localized timer duration");
    const error = requireElement(findMockElementByClass(form, "online-alarm-timer-error"), "localized timer error");
    duration.value = input;

    form.dispatch("submit");

    expect(error.text).toBe(expected);
    expect(addTimer).not.toHaveBeenCalled();
  });

  it("preserves timer input after failure, re-enables submit, and permits retry", async () => {
    const addTimer = vi.fn<(_durationMs: number, _label: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce(undefined);
    const items = { settings: { ...DEFAULT_SETTINGS }, addTimer } as unknown as ItemService;
    const onSuccess = vi.fn();
    const form = createTimerForm(new MockElement() as unknown as HTMLElement, items, "retry", onSuccess, EN_I18N) as unknown as MockElement;
    const duration = requireElement(findMockElementById(form, "retry-duration"), "timer duration");
    const label = requireElement(findMockElementById(form, "retry-label"), "timer label");
    const submit = requireElement(findMockElementByClass(form, "mod-cta"), "timer submit");
    const error = requireElement(findMockElementByClass(form, "online-alarm-timer-error"), "timer error");
    duration.value = "25m";
    label.value = "Keep this draft";

    form.dispatch("submit");
    await vi.waitFor(() => expect(error.text).toBe("The timer could not be saved."));

    expect(submit.disabled).toBe(false);
    expect(duration.value).toBe("25m");
    expect(label.value).toBe("Keep this draft");

    form.dispatch("submit");
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(addTimer).toHaveBeenCalledTimes(2);
    expect(submit.disabled).toBe(false);
  });

  it("prefills an alarm edit and reports parser errors without saving", () => {
    const target = new Date();
    target.setDate(target.getDate() + 1);
    target.setHours(14, 35, 0, 0);
    const item: AlarmItem = {
      id: "edit-alarm",
      type: "alarm",
      label: "Meeting",
      createdAt: 1,
      targetAt: target.getTime(),
      status: "active",
    };
    const updateAlarm = vi.fn(() => Promise.resolve(true));
    const items = { settings: { ...DEFAULT_SETTINGS }, updateAlarm } as unknown as ItemService;
    const form = createEditAlarmForm(new MockElement() as unknown as HTMLElement, items, item, "edit-alarm", vi.fn(), EN_I18N) as unknown as MockElement;
    const time = requireElement(findMockElementById(form, "edit-alarm-time"), "edit alarm time");
    const date = requireElement(findMockElementById(form, "edit-alarm-date"), "edit alarm date");
    const label = requireElement(findMockElementById(form, "edit-alarm-label"), "edit alarm label");
    const error = requireElement(findMockElementByClass(form, "online-alarm-timer-error"), "edit alarm error");

    expect(time.value).toBe("14:35");
    expect(date.value).toBe(tomorrowDateInput());
    expect(label.value).toBe("Meeting");

    time.value = "99:99";
    form.dispatch("submit");

    expect(updateAlarm).not.toHaveBeenCalled();
    expect(error.text).toBe("Enter a valid time.");
  });

  it("preserves an exact off-minute alarm target when only the label changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 18, 12, 0, 0, 0));
    const target = new Date(2026, 6, 18, 14, 35, 42, 789);
    const item: AlarmItem = {
      id: "precise-alarm",
      type: "alarm",
      label: "Original label",
      createdAt: 1,
      targetAt: target.getTime(),
      status: "active",
    };
    const updateAlarm = vi.fn(() => Promise.resolve(true));
    const items = { settings: { ...DEFAULT_SETTINGS }, updateAlarm } as unknown as ItemService;
    const form = createEditAlarmForm(new MockElement() as unknown as HTMLElement, items, item, "precise-alarm", vi.fn(), EN_I18N) as unknown as MockElement;
    const label = requireElement(findMockElementById(form, "precise-alarm-label"), "precise alarm label");
    label.value = "Updated label";

    form.dispatch("submit");

    expect(updateAlarm).toHaveBeenCalledOnce();
    expect(updateAlarm).toHaveBeenCalledWith(item.id, item.targetAt, "Updated label");
  });

  it("preserves an exact alarm target when submitted during its final displayed minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 18, 14, 35, 50, 0));
    const target = new Date(2026, 6, 18, 14, 35, 59, 500);
    const item: AlarmItem = {
      id: "final-minute-alarm",
      type: "alarm",
      label: "Almost due",
      createdAt: 1,
      targetAt: target.getTime(),
      status: "active",
    };
    const updateAlarm = vi.fn(() => Promise.resolve(true));
    const items = { settings: { ...DEFAULT_SETTINGS }, updateAlarm } as unknown as ItemService;
    const form = createEditAlarmForm(new MockElement() as unknown as HTMLElement, items, item, "final-minute-alarm", vi.fn(), EN_I18N) as unknown as MockElement;
    const error = requireElement(findMockElementByClass(form, "online-alarm-timer-error"), "final minute alarm error");

    form.dispatch("submit");

    expect(updateAlarm).toHaveBeenCalledOnce();
    expect(updateAlarm).toHaveBeenCalledWith(item.id, item.targetAt, item.label);
    expect(error.text).toBe("");
  });

  it("uses minute precision when an alarm schedule is changed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 18, 12, 0, 0, 0));
    const target = new Date(2026, 6, 18, 14, 35, 42, 789);
    const item: AlarmItem = {
      id: "rescheduled-alarm",
      type: "alarm",
      label: "Reschedule me",
      createdAt: 1,
      targetAt: target.getTime(),
      status: "active",
    };
    const updateAlarm = vi.fn(() => Promise.resolve(true));
    const items = { settings: { ...DEFAULT_SETTINGS }, updateAlarm } as unknown as ItemService;
    const form = createEditAlarmForm(new MockElement() as unknown as HTMLElement, items, item, "rescheduled-alarm", vi.fn(), EN_I18N) as unknown as MockElement;
    const time = requireElement(findMockElementById(form, "rescheduled-alarm-time"), "rescheduled alarm time");
    time.value = "14:36";

    form.dispatch("submit");

    const expectedTargetAt = new Date(2026, 6, 18, 14, 36, 0, 0).getTime();
    expect(updateAlarm).toHaveBeenCalledOnce();
    expect(updateAlarm).toHaveBeenCalledWith(item.id, expectedTargetAt, item.label);
    expect(expectedTargetAt).not.toBe(item.targetAt);
  });

});
