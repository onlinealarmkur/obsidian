import type { App, Plugin as ObsidianPlugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALARM_URL, DOCUMENTATION_URL, ISSUES_URL, REPOSITORY_URL, SOUND_PREVIEW_DURATION_MS, TIMER_URL } from "../src/constants";
import { EN_I18N } from "../src/i18n";
import type { AudioPlaybackHandle, AudioService } from "../src/services/audio-service";
import type { ItemService } from "../src/services/item-service";
import { DEFAULT_SETTINGS, type AlarmTimerSettings } from "../src/types";
import { AlarmTimerSettingTab } from "../src/ui/settings-tab";
import {
  getCreatedSettings,
  getRecordedNotices,
  getSettingByName,
  MockApp,
  Plugin,
  resetCreatedSettings,
  resetRecordedNotices
} from "./mocks/obsidian";

interface SettingsFixture {
  audioPreview: ReturnType<typeof vi.fn<(volume: number) => AudioPlaybackHandle>>;
  previewStop: ReturnType<typeof vi.fn<() => void>>;
  settings: AlarmTimerSettings;
  tab: AlarmTimerSettingTab;
  updateSettings: ReturnType<typeof vi.fn<(update: Partial<AlarmTimerSettings>) => Promise<void>>>;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (reason) => rejectPromise?.(reason),
    resolve: (value) => resolvePromise?.(value)
  };
}

function createFixture(): SettingsFixture {
  const settings = { ...DEFAULT_SETTINGS };
  const updateSettings = vi.fn((update: Partial<AlarmTimerSettings>) => {
    Object.assign(settings, update);
    return Promise.resolve();
  });
  const items = { settings, updateSettings } as unknown as ItemService;
  const previewStop = vi.fn<() => void>();
  const audioPreview = vi.fn((_volume: number) => ({ started: Promise.resolve(true), stop: previewStop }));
  const audio = { playPreview: audioPreview } as unknown as AudioService;
  const app = new MockApp();
  const plugin = new Plugin(app, { version: "9.8.7" });
  const tab = new AlarmTimerSettingTab(
    app as unknown as App,
    plugin as unknown as ObsidianPlugin,
    items,
    audio,
    EN_I18N
  );
  return { audioPreview, previewStop, settings, tab, updateSettings };
}

function requiredSetting(name: string) {
  const setting = getSettingByName(name);
  expect(setting, `Expected setting ${name}`).toBeDefined();
  if (setting === undefined) throw new Error(`Missing setting ${name}.`);
  return setting;
}

function render(tab: AlarmTimerSettingTab): void {
  (tab as unknown as { display: () => void }).display();
}

describe("AlarmTimerSettingTab", () => {
  beforeEach(() => {
    resetCreatedSettings();
    resetRecordedNotices();
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the complete settings surface and current values", () => {
    const fixture = createFixture();
    render(fixture.tab);

    expect(getCreatedSettings().map((setting) => setting.name)).toEqual([
      "Default timer duration",
      "Quick timer durations",
      "Use 24-hour time",
      "Show next item in status bar",
      "",
      "Alerts",
      "Enable sound",
      "Alert volume",
      "System notifications",
      "Overdue grace period",
      "Test sound",
      "About",
      "Privacy",
      "Documentation",
      "Online alarm clock",
      "Online timer",
      "Report an issue",
      "Version"
    ]);
    expect(getCreatedSettings().filter((setting) => setting.heading).map((setting) => setting.name)).toEqual([
      "Alerts",
      "About"
    ]);
    expect(requiredSetting("Default timer duration").texts[0]?.value).toBe("10");
    expect(requiredSetting("Default timer duration").texts[0]?.inputEl).toMatchObject({
      type: "number",
      min: "1",
      max: "43200",
      step: "1"
    });
    expect(requiredSetting("Quick timer durations").texts[0]?.value).toBe("1, 5, 10, 15, 30, 60");
    expect(requiredSetting("Quick timer durations").description).toContain("1 to 6 whole-minute durations");
    expect(requiredSetting("Alert volume").sliders[0]?.value).toBe(70);
    expect(requiredSetting("Alert volume").sliders[0]?.limits).toEqual({ minimum: 0, maximum: 100, step: 1 });
    expect(requiredSetting("Version").description).toBe("9.8.7");
  });

  it("rejects a fractional default timer value and restores the saved integer", async () => {
    const fixture = createFixture();
    render(fixture.tab);
    const text = requiredSetting("Default timer duration").texts[0];

    await text?.trigger("1.5");

    expect(text?.value).toBe("10");
    expect(fixture.updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["", "an empty value"],
    ["0, 5", "a value below the minimum"],
    ["1.5, 5", "a fractional value"],
    ["1, two", "a non-number"],
    ["1, 2, 3, 4, 5, 6, 7", "more than six unique values"],
    ["43201", "a value above the maximum"]
  ])("rejects %s as %s and restores quick timer durations", async (value) => {
    const fixture = createFixture();
    render(fixture.tab);
    const text = requiredSetting("Quick timer durations").texts[0];

    await text?.trigger(value);

    expect(text?.value).toBe("1, 5, 10, 15, 30, 60");
    expect(fixture.updateSettings).not.toHaveBeenCalled();
    expect(getRecordedNotices()).toEqual([{ message: "Enter 1 to 6 whole-minute quick durations between 1 and 43200." }]);
  });

  it("deduplicates quick timer durations while preserving their order", async () => {
    const fixture = createFixture();
    render(fixture.tab);
    const text = requiredSetting("Quick timer durations").texts[0];

    await text?.trigger("30, 5, 30, 1");

    expect(text?.value).toBe("30, 5, 1");
    expect(fixture.updateSettings).toHaveBeenCalledWith({ quickTimerMinutes: [30, 5, 1] });
    expect(fixture.settings.quickTimerMinutes).toEqual([30, 5, 1]);
  });

  it("allows a trailing separator while another quick duration is being typed", async () => {
    const fixture = createFixture();
    render(fixture.tab);
    const text = requiredSetting("Quick timer durations").texts[0];

    await text?.trigger("2,");

    expect(text?.value).toBe("2,");
    expect(fixture.updateSettings).not.toHaveBeenCalled();
    expect(getRecordedNotices()).toEqual([]);

    await text?.trigger("2, 20");

    expect(text?.value).toBe("2, 20");
    expect(fixture.updateSettings).toHaveBeenCalledWith({ quickTimerMinutes: [2, 20] });
  });

  it("restores an unfinished quick duration when the field loses focus", async () => {
    const fixture = createFixture();
    render(fixture.tab);
    const text = requiredSetting("Quick timer durations").texts[0];

    await text?.trigger("2,");
    text?.inputEl.dispatch("blur");

    await vi.waitFor(() => expect(text?.value).toBe("1, 5, 10, 15, 30, 60"));
    expect(fixture.updateSettings).not.toHaveBeenCalled();
    expect(getRecordedNotices()).toEqual([{ message: "Enter 1 to 6 whole-minute quick durations between 1 and 43200." }]);
  });

  it("persists valid text, toggle, and slider changes", async () => {
    const fixture = createFixture();
    render(fixture.tab);

    await requiredSetting("Default timer duration").texts[0]?.trigger("25");
    await requiredSetting("Quick timer durations").texts[0]?.trigger("2, 20, 120");
    await requiredSetting("Use 24-hour time").toggles[0]?.trigger(true);
    await requiredSetting("Show next item in status bar").toggles[0]?.trigger(false);
    await requiredSetting("Enable sound").toggles[0]?.trigger(false);
    await requiredSetting("Alert volume").sliders[0]?.trigger(35);
    await requiredSetting("Overdue grace period").texts[0]?.trigger("30");

    expect(fixture.updateSettings.mock.calls.map(([update]) => update)).toEqual([
      { defaultTimerMinutes: 25 },
      { quickTimerMinutes: [2, 20, 120] },
      { use24HourTime: true },
      { showStatusBar: false },
      { enableSound: false },
      { volume: 35 },
      { overdueGraceMinutes: 30 }
    ]);
  });

  it.each([
    ["", "an empty value"],
    ["abc", "a non-number"],
    ["1.5", "a fractional value"]
  ])("rejects %s as %s and restores the saved overdue grace period", async (value, _description) => {
    const fixture = createFixture();
    render(fixture.tab);
    const text = requiredSetting("Overdue grace period").texts[0];

    await text?.trigger(value);

    expect(text?.value).toBe("15");
    expect(fixture.updateSettings).not.toHaveBeenCalled();
  });

  it("persists an explicit zero overdue grace period", async () => {
    const fixture = createFixture();
    render(fixture.tab);
    const text = requiredSetting("Overdue grace period").texts[0];

    await text?.trigger("0");

    expect(fixture.updateSettings).toHaveBeenCalledWith({ overdueGraceMinutes: 0 });
  });

  it("plays the configured test sound and reports playback failure", async () => {
    const fixture = createFixture();
    fixture.audioPreview.mockReturnValueOnce({ started: Promise.resolve(false), stop: fixture.previewStop });
    render(fixture.tab);

    await requiredSetting("Test sound").buttons[0]?.trigger();

    expect(fixture.audioPreview).toHaveBeenCalledWith(70);
    expect(getRecordedNotices()).toEqual([{ message: "The alert sound could not be played." }]);
  });

  it("lets the user stop a short sound preview and cleans it up when settings hide", async () => {
    const fixture = createFixture();
    render(fixture.tab);
    const button = requiredSetting("Test sound").buttons[0];

    await button?.trigger();

    expect(button?.buttonText).toBe("Stop sound");
    expect(fixture.audioPreview).toHaveBeenCalledWith(70);

    await button?.trigger();

    expect(fixture.previewStop).toHaveBeenCalledOnce();
    expect(button?.buttonText).toBe("Test sound");

    await button?.trigger();
    expect(fixture.audioPreview).toHaveBeenCalledTimes(2);
    expect(button?.buttonText).toBe("Stop sound");

    fixture.tab.hide();

    expect(fixture.previewStop).toHaveBeenCalledTimes(2);
    expect(button?.buttonText).toBe("Test sound");
  });

  it("cancels a sound preview while Web Audio startup is still pending", async () => {
    const started = deferred<boolean>();
    const fixture = createFixture();
    fixture.audioPreview.mockReturnValueOnce({ started: started.promise, stop: fixture.previewStop });
    render(fixture.tab);
    const button = requiredSetting("Test sound").buttons[0];

    const starting = button?.trigger();
    expect(button?.buttonText).toBe("Cancel test");

    await button?.trigger();
    expect(fixture.previewStop).toHaveBeenCalledOnce();
    expect(button?.buttonText).toBe("Test sound");

    started.resolve(false);
    await starting;
    expect(getRecordedNotices()).toEqual([]);
  });

  it("automatically resets the sound-preview control after the short sample", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout
    });
    const fixture = createFixture();
    render(fixture.tab);
    const button = requiredSetting("Test sound").buttons[0];

    await button?.trigger();
    expect(button?.buttonText).toBe("Stop sound");

    await vi.advanceTimersByTimeAsync(SOUND_PREVIEW_DURATION_MS);

    expect(fixture.previewStop).toHaveBeenCalledOnce();
    expect(button?.buttonText).toBe("Test sound");
  });

  it("opens each external link only after its button is clicked", async () => {
    const open = vi.fn<(url: string, target: string, features: string) => void>();
    vi.stubGlobal("window", { open });
    const fixture = createFixture();
    render(fixture.tab);

    expect(open).not.toHaveBeenCalled();
    for (const name of ["Documentation", "Online alarm clock", "Online timer", "Report an issue"]) {
      await requiredSetting(name).buttons[0]?.trigger();
    }

    expect(open.mock.calls.map(([url]) => url)).toEqual([DOCUMENTATION_URL, ALARM_URL, TIMER_URL, ISSUES_URL]);
    expect(open.mock.calls.every((call) => call[1] === "_blank" && call[2] === "noopener,noreferrer")).toBe(true);
  });

  it("targets documentation and issues in the intended GitHub repository", () => {
    expect(REPOSITORY_URL).toBe("https://github.com/onlinealarmkur/obsidian");
    expect(DOCUMENTATION_URL).toBe(`${REPOSITORY_URL}#readme`);
    expect(ISSUES_URL).toBe(`${REPOSITORY_URL}/issues`);
  });

  it("enables notifications when permission is already granted", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    const fixture = createFixture();
    render(fixture.tab);

    await requiredSetting("System notifications").toggles[0]?.trigger(true);

    expect(fixture.updateSettings).toHaveBeenCalledWith({ enableSystemNotifications: true });
    expect(getRecordedNotices()).toEqual([]);
  });

  it("keeps notifications disabled when permission is denied", async () => {
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });
    const fixture = createFixture();
    render(fixture.tab);
    const toggle = requiredSetting("System notifications").toggles[0];

    await toggle?.trigger(true);

    expect(toggle?.value).toBe(false);
    expect(fixture.updateSettings).toHaveBeenCalledWith({ enableSystemNotifications: false });
    expect(getRecordedNotices()[0]?.message).toContain("blocked");
  });

  it("keeps notifications disabled when the API is unavailable", async () => {
    vi.stubGlobal("Notification", undefined);
    const fixture = createFixture();
    render(fixture.tab);

    await requiredSetting("System notifications").toggles[0]?.trigger(true);

    expect(fixture.updateSettings).toHaveBeenCalledWith({ enableSystemNotifications: false });
    expect(getRecordedNotices()[0]?.message).toContain("not available");
  });

  it("restores every persisted control after save failures", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    const fixture = createFixture();
    fixture.updateSettings.mockRejectedValue(new Error("save failed"));
    render(fixture.tab);
    const timer = requiredSetting("Default timer duration").texts[0];
    const quick = requiredSetting("Quick timer durations").texts[0];
    const clock = requiredSetting("Use 24-hour time").toggles[0];
    const status = requiredSetting("Show next item in status bar").toggles[0];
    const sound = requiredSetting("Enable sound").toggles[0];
    const volume = requiredSetting("Alert volume").sliders[0];
    const notifications = requiredSetting("System notifications").toggles[0];
    const overdue = requiredSetting("Overdue grace period").texts[0];

    await timer?.trigger("25");
    await quick?.trigger("2, 20, 120");
    await clock?.trigger(true);
    await status?.trigger(false);
    await sound?.trigger(false);
    await volume?.trigger(35);
    await notifications?.trigger(true);
    await overdue?.trigger("30");

    expect(timer?.value).toBe("10");
    expect(quick?.value).toBe("1, 5, 10, 15, 30, 60");
    expect(clock?.value).toBe(false);
    expect(status?.value).toBe(true);
    expect(sound?.value).toBe(true);
    expect(volume?.value).toBe(70);
    expect(notifications?.value).toBe(false);
    expect(overdue?.value).toBe("15");
    expect(getRecordedNotices()).toEqual(Array.from({ length: 8 }, () => ({ message: "The settings change could not be saved." })));
  });

  it("lets a newer disable action win over deferred notification permission", async () => {
    const permission = deferred<NotificationPermission>();
    const requestPermission = vi.fn(() => permission.promise);
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const fixture = createFixture();
    render(fixture.tab);
    const toggle = requiredSetting("System notifications").toggles[0];

    const enabling = toggle?.trigger(true);
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());
    await toggle?.trigger(false);
    permission.resolve("granted");
    await enabling;

    expect(toggle?.value).toBe(false);
    expect(fixture.settings.enableSystemNotifications).toBe(false);
    expect(fixture.updateSettings.mock.calls.map(([update]) => update)).toEqual([
      { enableSystemNotifications: false }
    ]);
  });

  it("keeps a newer volume when an older save fails", async () => {
    const firstSave = deferred<undefined>();
    const secondSave = deferred<undefined>();
    const fixture = createFixture();
    fixture.updateSettings.mockReset()
      .mockImplementationOnce(async (update) => {
        await firstSave.promise;
        Object.assign(fixture.settings, update);
      })
      .mockImplementationOnce(async (update) => {
        await secondSave.promise;
        Object.assign(fixture.settings, update);
      });
    render(fixture.tab);
    const volume = requiredSetting("Alert volume").sliders[0];

    const olderChange = volume?.trigger(20);
    const newerChange = volume?.trigger(35);
    firstSave.reject(new Error("older save failed"));
    await olderChange;
    expect(volume?.value).toBe(35);
    expect(getRecordedNotices()).toEqual([]);

    secondSave.resolve(undefined);
    await newerChange;
    expect(fixture.settings.volume).toBe(35);
    expect(volume?.value).toBe(35);
    expect(getRecordedNotices()).toEqual([]);
  });

  it("keeps a newer quick timer change when an older save fails", async () => {
    const firstSave = deferred<undefined>();
    const secondSave = deferred<undefined>();
    const fixture = createFixture();
    fixture.updateSettings.mockReset()
      .mockImplementationOnce(async (update) => {
        await firstSave.promise;
        Object.assign(fixture.settings, update);
      })
      .mockImplementationOnce(async (update) => {
        await secondSave.promise;
        Object.assign(fixture.settings, update);
      });
    render(fixture.tab);
    const quick = requiredSetting("Quick timer durations").texts[0];

    const olderChange = quick?.trigger("2, 20");
    const newerChange = quick?.trigger("3, 30, 3");
    firstSave.reject(new Error("older save failed"));
    await olderChange;
    expect(quick?.value).toBe("3, 30");
    expect(getRecordedNotices()).toEqual([]);

    secondSave.resolve(undefined);
    await newerChange;
    expect(fixture.settings.quickTimerMinutes).toEqual([3, 30]);
    expect(quick?.value).toBe("3, 30");
    expect(getRecordedNotices()).toEqual([]);
  });

  it("restores the last saved volume when the newer save fails", async () => {
    const firstSave = deferred<undefined>();
    const secondSave = deferred<undefined>();
    const fixture = createFixture();
    fixture.updateSettings.mockReset()
      .mockImplementationOnce(async (update) => {
        await firstSave.promise;
        Object.assign(fixture.settings, update);
      })
      .mockImplementationOnce(async (update) => {
        await secondSave.promise;
        Object.assign(fixture.settings, update);
      });
    render(fixture.tab);
    const volume = requiredSetting("Alert volume").sliders[0];

    const olderChange = volume?.trigger(20);
    const newerChange = volume?.trigger(35);
    firstSave.resolve(undefined);
    await olderChange;
    expect(fixture.settings.volume).toBe(20);
    expect(volume?.value).toBe(35);

    secondSave.reject(new Error("newer save failed"));
    await newerChange;
    expect(fixture.settings.volume).toBe(20);
    expect(volume?.value).toBe(20);
    expect(getRecordedNotices()).toEqual([{ message: "The settings change could not be saved." }]);
  });

  it("tracks simultaneous updates independently for different settings", async () => {
    const volumeSave = deferred<undefined>();
    const soundSave = deferred<undefined>();
    const fixture = createFixture();
    fixture.updateSettings.mockReset().mockImplementation(async (update) => {
      if (update.volume !== undefined) await volumeSave.promise;
      if (update.enableSound !== undefined) await soundSave.promise;
      Object.assign(fixture.settings, update);
    });
    render(fixture.tab);
    const volume = requiredSetting("Alert volume").sliders[0];
    const sound = requiredSetting("Enable sound").toggles[0];

    const volumeChange = volume?.trigger(25);
    const soundChange = sound?.trigger(false);
    soundSave.resolve(undefined);
    await soundChange;
    volumeSave.reject(new Error("volume save failed"));
    await volumeChange;

    expect(fixture.settings.enableSound).toBe(false);
    expect(sound?.value).toBe(false);
    expect(fixture.settings.volume).toBe(70);
    expect(volume?.value).toBe(70);
    expect(getRecordedNotices()).toEqual([{ message: "The settings change could not be saved." }]);
  });
});
