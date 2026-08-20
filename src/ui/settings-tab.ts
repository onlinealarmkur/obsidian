import { Notice, PluginSettingTab, Setting, type App, type ButtonComponent, type Plugin } from "obsidian";
import {
  ALARM_URL,
  DOCUMENTATION_URL,
  ISSUES_URL,
  MAX_OVERDUE_GRACE_MINUTES,
  MAX_QUICK_TIMER_DURATIONS,
  MAX_TIMER_MINUTES,
  MAX_VOLUME,
  MIN_OVERDUE_GRACE_MINUTES,
  MIN_TIMER_MINUTES,
  MIN_VOLUME,
  SOUND_PREVIEW_DURATION_MS,
  TIMER_URL
} from "../constants";
import { normalizeQuickTimerMinutes } from "../data/validation";
import type { I18n } from "../i18n";
import type { AudioPlaybackHandle, AudioService } from "../services/audio-service";
import type { ItemService } from "../services/item-service";

interface SearchableSettingDefinition {
  name: string;
  desc?: string;
  searchable?: boolean;
  render: (setting: Setting) => void;
}

interface SearchableSettingGroup {
  type: "group";
  heading: string;
  items: SearchableSettingDefinition[];
}

type SearchableSettingItem = SearchableSettingDefinition | SearchableSettingGroup;

export class AlarmTimerSettingTab extends PluginSettingTab {
  private readonly version: string;
  private notificationGeneration = 0;
  private readonly settingGenerations = new Map<keyof Parameters<ItemService["updateSettings"]>[0], number>();
  private nextSettingGeneration = 0;
  private soundPreviewGeneration = 0;
  private soundPreview?: AudioPlaybackHandle;
  private soundPreviewButton?: ButtonComponent;
  private soundPreviewTimer?: number;

  public constructor(
    app: App,
    plugin: Plugin,
    private readonly items: ItemService,
    private readonly audio: AudioService,
    private readonly i18n: I18n
  ) {
    super(app, plugin);
    this.version = plugin.manifest.version;
  }

  public override getSettingDefinitions(): SearchableSettingItem[] {
    const { messages } = this.i18n;
    return [
      {
        name: messages.defaultTimerDuration,
        desc: messages.defaultTimerDurationDesc,
        render: (setting) => {
          setting.addText((text) => {
            text.inputEl.type = "number";
            text.inputEl.min = String(MIN_TIMER_MINUTES);
            text.inputEl.max = String(MAX_TIMER_MINUTES);
            text.inputEl.step = "1";
            text.setValue(String(this.items.settings.defaultTimerMinutes)).onChange(async (value) => {
              const parsed = Number(value);
              const restore = (): void => { text.setValue(String(this.items.settings.defaultTimerMinutes)); };
              if (!Number.isInteger(parsed) || parsed < MIN_TIMER_MINUTES || parsed > MAX_TIMER_MINUTES) {
                restore();
                return;
              }
              await this.persistSetting("defaultTimerMinutes", { defaultTimerMinutes: parsed }, restore);
            });
          });
        }
      },
      {
        name: messages.quickTimerDurations,
        desc: messages.quickTimerDurationsDesc(MIN_TIMER_MINUTES, MAX_QUICK_TIMER_DURATIONS, MAX_TIMER_MINUTES),
        render: (setting) => {
          setting.addText((text) => {
            const currentValue = (): string => this.items.settings.quickTimerMinutes.join(", ");
            const commit = async (value: string): Promise<void> => {
              const parsed = this.parseQuickTimerMinutes(value);
              const restore = (): void => { text.setValue(currentValue()); };
              if (parsed === undefined) {
                restore();
                new Notice(messages.quickTimerDurationsInvalid(MIN_TIMER_MINUTES, MAX_QUICK_TIMER_DURATIONS, MAX_TIMER_MINUTES));
                return;
              }
              text.setValue(parsed.join(", "));
              if (parsed.length === this.items.settings.quickTimerMinutes.length
                && parsed.every((minutes, index) => minutes === this.items.settings.quickTimerMinutes[index])) return;
              await this.persistSetting("quickTimerMinutes", { quickTimerMinutes: parsed }, restore);
            };
            text.setValue(currentValue()).onChange(async (value) => {
              // A trailing separator is a normal intermediate state while entering
              // another duration. Validate it only when the field loses focus.
              if (/,[\s]*$/.test(value)) return;
              await commit(value);
            });
            text.inputEl.addEventListener("blur", () => { void commit(text.inputEl.value); });
          });
        }
      },
      {
        name: messages.use24HourTime,
        desc: messages.use24HourTimeDesc,
        render: (setting) => {
          setting.addToggle((toggle) => toggle.setValue(this.items.settings.use24HourTime).onChange(async (value) => {
            await this.persistSetting(
              "use24HourTime",
              { use24HourTime: value },
              () => { toggle.setValue(this.items.settings.use24HourTime); }
            );
          }));
        }
      },
      {
        name: messages.showStatusBar,
        desc: messages.showStatusBarDesc,
        render: (setting) => {
          setting.addToggle((toggle) => toggle.setValue(this.items.settings.showStatusBar).onChange(async (value) => {
            await this.persistSetting(
              "showStatusBar",
              { showStatusBar: value },
              () => { toggle.setValue(this.items.settings.showStatusBar); }
            );
          }));
        }
      },
      {
        name: "",
        desc: messages.closedAppLimitation,
        searchable: false,
        render: () => undefined
      },
      {
        type: "group",
        heading: messages.alerts,
        items: [
          {
            name: messages.enableSound,
            desc: messages.enableSoundDesc,
            render: (setting) => {
              setting.addToggle((toggle) => toggle.setValue(this.items.settings.enableSound).onChange(async (value) => {
                await this.persistSetting(
                  "enableSound",
                  { enableSound: value },
                  () => { toggle.setValue(this.items.settings.enableSound); }
                );
              }));
            }
          },
          {
            name: messages.alertVolume,
            desc: messages.alertVolumeDesc(MIN_VOLUME, MAX_VOLUME),
            render: (setting) => {
              setting.addSlider((slider) => slider.setLimits(MIN_VOLUME, MAX_VOLUME, 1)
                .setValue(this.items.settings.volume).onChange(async (value) => {
                await this.persistSetting(
                  "volume",
                  { volume: value },
                  () => { slider.setValue(this.items.settings.volume); }
                );
              }));
            }
          },
          {
            name: messages.systemNotifications,
            desc: messages.systemNotificationsDesc,
            render: (setting) => {
              setting.addToggle((toggle) => toggle.setValue(this.items.settings.enableSystemNotifications).onChange(async (value) => {
                const generation = ++this.notificationGeneration;
                const enabled = value ? await this.requestNotificationPermission() : false;
                if (generation !== this.notificationGeneration) return;
                toggle.setValue(enabled);
                await this.persistSetting(
                  "enableSystemNotifications",
                  { enableSystemNotifications: enabled },
                  () => { toggle.setValue(this.items.settings.enableSystemNotifications); }
                );
              }));
            }
          },
          {
            name: messages.overdueGracePeriod,
            desc: messages.overdueGracePeriodDesc,
            render: (setting) => {
              setting.addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = String(MIN_OVERDUE_GRACE_MINUTES);
                text.inputEl.max = String(MAX_OVERDUE_GRACE_MINUTES);
                text.inputEl.step = "1";
                text.setValue(String(this.items.settings.overdueGraceMinutes)).onChange(async (value) => {
                  const trimmed = value.trim();
                  const parsed = Number(trimmed);
                  const restore = (): void => { text.setValue(String(this.items.settings.overdueGraceMinutes)); };
                  if (trimmed === "" || !Number.isInteger(parsed)
                    || parsed < MIN_OVERDUE_GRACE_MINUTES || parsed > MAX_OVERDUE_GRACE_MINUTES) {
                    restore();
                    return;
                  }
                  await this.persistSetting("overdueGraceMinutes", { overdueGraceMinutes: parsed }, restore);
                });
              });
            }
          },
          {
            name: messages.testSound,
            desc: messages.testSoundDesc,
            render: (setting) => {
              setting.addButton((button) => {
                this.soundPreviewButton = button;
                button.setButtonText(messages.testSound).onClick(() => this.toggleSoundPreview());
              });
              return () => { this.teardownSoundPreview(); };
            }
          }
        ]
      },
      {
        type: "group",
        heading: messages.about,
        items: [
          { name: messages.privacy, desc: messages.privacyDesc, render: () => undefined },
          this.linkDefinition(messages.documentation, messages.documentationDesc, DOCUMENTATION_URL),
          this.linkDefinition(messages.onlineAlarmClock, messages.onlineAlarmClockDesc, ALARM_URL),
          this.linkDefinition(messages.onlineTimer, messages.onlineTimerDesc, TIMER_URL),
          this.linkDefinition(messages.reportIssue, messages.reportIssueDesc, ISSUES_URL),
          { name: messages.version, desc: this.version, render: () => undefined }
        ]
      }
    ];
  }

  public override display(): void {
    this.teardownSoundPreview();
    ++this.notificationGeneration;
    this.settingGenerations.clear();
    this.containerEl.empty();
    for (const item of this.getSettingDefinitions()) {
      if ("type" in item) {
        new Setting(this.containerEl).setName(item.heading).setHeading();
        for (const definition of item.items) this.renderLegacyDefinition(definition);
      } else {
        this.renderLegacyDefinition(item);
      }
    }
  }

  public override hide(): void {
    ++this.notificationGeneration;
    this.settingGenerations.clear();
    this.teardownSoundPreview();
    super.hide();
  }

  private linkDefinition(name: string, desc: string, url: string): SearchableSettingDefinition {
    return {
      name,
      desc,
      render: (setting) => {
        setting.addButton((button) => button.setButtonText(this.i18n.messages.open).onClick(() => {
          window.open(url, "_blank", "noopener,noreferrer");
        }));
      }
    };
  }

  private renderLegacyDefinition(definition: SearchableSettingDefinition): void {
    const setting = new Setting(this.containerEl).setName(definition.name);
    if (definition.desc !== undefined) setting.setDesc(definition.desc);
    definition.render(setting);
  }

  private parseQuickTimerMinutes(value: string): number[] | undefined {
    const parts = value.split(",").map((part) => part.trim());
    if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
    const candidates = parts.map(Number);
    if (candidates.some((minutes) => !Number.isInteger(minutes) || minutes < MIN_TIMER_MINUTES || minutes > MAX_TIMER_MINUTES)) return undefined;
    if (new Set(candidates).size > MAX_QUICK_TIMER_DURATIONS) return undefined;
    const normalized = normalizeQuickTimerMinutes(candidates);
    return normalized;
  }

  private async toggleSoundPreview(): Promise<void> {
    if (this.soundPreview !== undefined) {
      this.stopSoundPreview();
      return;
    }
    const generation = ++this.soundPreviewGeneration;
    this.soundPreviewButton?.setButtonText(this.i18n.messages.cancelTest);
    const preview = this.audio.playPreview(this.items.settings.volume);
    this.soundPreview = preview;
    const played = await preview.started;
    if (generation !== this.soundPreviewGeneration) {
      return;
    }
    if (!played) {
      this.soundPreview = undefined;
      this.soundPreviewButton?.setButtonText(this.i18n.messages.testSound);
      new Notice(this.i18n.messages.alertSoundFailed);
      return;
    }
    this.soundPreviewButton?.setButtonText(this.i18n.messages.stopSound);
    this.soundPreviewTimer = window.setTimeout(() => {
      if (generation !== this.soundPreviewGeneration) return;
      preview.stop();
      this.soundPreview = undefined;
      this.soundPreviewTimer = undefined;
      this.soundPreviewButton?.setButtonText(this.i18n.messages.testSound);
    }, SOUND_PREVIEW_DURATION_MS);
  }

  private stopSoundPreview(): void {
    ++this.soundPreviewGeneration;
    this.soundPreview?.stop();
    this.soundPreview = undefined;
    if (this.soundPreviewTimer !== undefined) window.clearTimeout(this.soundPreviewTimer);
    this.soundPreviewTimer = undefined;
    this.soundPreviewButton?.setButtonText(this.i18n.messages.testSound);
  }

  private teardownSoundPreview(): void {
    this.stopSoundPreview();
    this.soundPreviewButton = undefined;
  }

  private async persistSetting(
    key: keyof Parameters<ItemService["updateSettings"]>[0],
    update: Parameters<ItemService["updateSettings"]>[0],
    restore: () => void
  ): Promise<void> {
    const generation = ++this.nextSettingGeneration;
    this.settingGenerations.set(key, generation);
    try {
      await this.items.updateSettings(update);
    } catch {
      if (this.settingGenerations.get(key) !== generation) return;
      restore();
      new Notice(this.i18n.messages.settingsSaveFailed);
    }
  }

  private async requestNotificationPermission(): Promise<boolean> {
    if (typeof Notification === "undefined") {
      new Notice(this.i18n.messages.notificationsUnavailable);
      return false;
    }
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") {
      new Notice(this.i18n.messages.notificationsBlocked);
      return false;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") new Notice(this.i18n.messages.notificationPermissionDenied);
      return permission === "granted";
    } catch {
      new Notice(this.i18n.messages.notificationPermissionRequestFailed);
      return false;
    }
  }
}
