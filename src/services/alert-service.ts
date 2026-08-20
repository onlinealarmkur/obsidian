import { Notice, type App } from "obsidian";
import type { I18n } from "../i18n";
import type { ScheduledItem } from "../types";
import { displayLabel } from "../utils/formatting";
import type { ItemService } from "./item-service";
import type { AudioService } from "./audio-service";
import { AlertModal } from "../ui/alert-modal";

interface AlertItems {
  readonly settings: ItemService["settings"];
  reserveAlert: ItemService["reserveAlert"];
  releaseAlert: ItemService["releaseAlert"];
  acknowledgeFired?: ItemService["acknowledgeFired"];
  restartFiredTimer?: ItemService["restartFiredTimer"];
}

export class AlertService {
  private readonly queue: ScheduledItem[] = [];
  private activeModal?: AlertModal;
  private activeNotification?: Notification;
  private activeItem?: ScheduledItem;
  private presentationGeneration = 0;
  private stopped = false;

  public constructor(
    private readonly app: App,
    private readonly items: AlertItems,
    private readonly audio: Pick<AudioService, "play" | "stop">,
    private readonly openAlarmView: () => Promise<void>,
    private readonly i18n: I18n
  ) {}

  public enqueue(item: ScheduledItem): void {
    if (this.stopped) return;
    if (!this.items.reserveAlert(item.id)) return;
    this.queue.push(item);
    this.showNext();
  }

  public stopActive(): void {
    this.activeModal?.stop();
  }

  public hasActiveAlert(): boolean {
    return !this.stopped
      && this.activeItem !== undefined
      && (this.activeModal?.isIdle() ?? false);
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.queue.length === 0 && this.activeItem === undefined && this.activeModal === undefined && this.activeNotification === undefined) return;
    for (const item of this.queue) this.items.releaseAlert(item.id);
    this.queue.length = 0;
    ++this.presentationGeneration;
    const item = this.activeItem;
    const modal = this.activeModal;
    this.activeItem = undefined;
    this.activeModal = undefined;
    this.closeSystemNotification();
    if (item !== undefined) this.items.releaseAlert(item.id);
    modal?.closeResolved();
    this.audio.stop();
  }

  private showNext(): void {
    if (this.stopped) return;
    if (this.activeModal !== undefined) return;
    const item = this.queue.shift();
    if (item === undefined) return;
    this.activeItem = item;
    const presentationGeneration = ++this.presentationGeneration;
    let modal: AlertModal | undefined;
    try {
      new Notice(this.alertNotice(item));
      if (this.items.settings.enableSystemNotifications && typeof Notification !== "undefined" && Notification.permission === "granted") {
        this.showSystemNotification(item, presentationGeneration);
      }
      if (this.items.settings.enableSound) {
        void this.audio.play(this.items.settings.volume).then((played) => {
          if (!played && this.activeItem?.id === item.id && this.presentationGeneration === presentationGeneration) {
            new Notice(this.i18n.messages.alertSoundSettingsFailed);
          }
        }).catch((error: unknown) => this.rollbackPresentation(item, modal, presentationGeneration, error));
      }
      modal = new AlertModal(
        this.app,
        item,
        this.items.settings.use24HourTime,
        {
          stop: async () => {
            const acknowledged = await this.runCurrentMutation(
              presentationGeneration,
              () => this.items.acknowledgeFired?.(item.id) ?? Promise.resolve(false)
            );
            if (acknowledged === false) throw new Error("The pending alert no longer exists.");
            if (acknowledged === true) this.finishCurrent(item, presentationGeneration);
          },
          releaseAfterClosedFailure: () => this.releaseFailedClosedAlert(item, presentationGeneration),
          ...(item.type === "timer"
            ? {
                restartTimer: async () => {
                  const restarted = await this.runCurrentMutation(
                    presentationGeneration,
                    () => this.items.restartFiredTimer?.(item.id) ?? Promise.resolve(false)
                  );
                  if (restarted === false) throw new Error("The completed timer no longer exists.");
                  if (restarted === true) this.finishCurrent(item, presentationGeneration);
                }
              }
            : {})
        },
        this.i18n
      );
      this.activeModal = modal;
      modal.open();
    } catch (error) {
      this.rollbackPresentation(item, modal, presentationGeneration, error);
    }
  }

  private async runCurrentMutation(
    presentationGeneration: number,
    mutation: () => Promise<boolean>
  ): Promise<boolean | undefined> {
    try {
      const changed = await mutation();
      if (this.presentationGeneration !== presentationGeneration) return undefined;
      return changed;
    } catch (error) {
      if (this.presentationGeneration !== presentationGeneration) return undefined;
      throw error;
    }
  }

  private showSystemNotification(item: ScheduledItem, generation: number): void {
    try {
      this.closeSystemNotification();
      const notification = new Notification(item.type === "alarm" ? this.i18n.messages.alarm : this.i18n.messages.timer, { body: displayLabel(item, this.i18n) });
      this.activeNotification = notification;
      notification.onclick = () => { void this.handleSystemNotificationClick(notification, item, generation); };
    } catch (error) {
      new Notice(this.i18n.messages.systemNotificationShowFailed);
      console.error("Alarm and Timer system notification failed.", error);
    }
  }

  private async handleSystemNotificationClick(notification: Notification, item: ScheduledItem, generation: number): Promise<void> {
    let failed = !this.closeSystemNotification(notification);
    if (!this.isPresentationCurrent(item, generation)) return;
    try {
      if (typeof window !== "undefined" && typeof window.focus === "function") await Promise.resolve(window.focus());
    } catch (error) {
      failed = true;
      console.error("Alarm and Timer could not focus the app from a system notification.", error);
    }
    if (!this.isPresentationCurrent(item, generation)) return;
    try {
      await this.openAlarmView();
    } catch (error) {
      failed = true;
      console.error("Alarm and Timer could not open the sidebar from a system notification.", error);
    }
    if (failed && this.isPresentationCurrent(item, generation)) {
      new Notice(this.i18n.messages.systemNotificationActionFailed);
    }
  }

  private isPresentationCurrent(item: ScheduledItem, generation: number): boolean {
    return !this.stopped && this.presentationGeneration === generation && this.activeItem?.id === item.id;
  }

  private closeSystemNotification(notification = this.activeNotification): boolean {
    if (notification === undefined) return true;
    if (this.activeNotification === notification) this.activeNotification = undefined;
    try {
      notification.close();
      return true;
    } catch (error) {
      console.error("Alarm and Timer could not close a system notification.", error);
      return false;
    }
  }

  private rollbackPresentation(item: ScheduledItem, modal: AlertModal | undefined, generation: number, error: unknown): void {
    if (this.presentationGeneration !== generation || this.activeItem?.id !== item.id) return;
    ++this.presentationGeneration;
    this.activeItem = undefined;
    this.activeModal = undefined;
    this.closeSystemNotification();
    try { modal?.closeResolved(); } catch (closeError) { console.error("Alarm and Timer could not close a failed alert modal.", closeError); }
    try { this.audio.stop(); } catch (stopError) { console.error("Alarm and Timer could not stop audio after alert presentation failed.", stopError); }
    try { this.items.releaseAlert(item.id); } catch (releaseError) { console.error("Alarm and Timer could not release a failed alert presentation.", releaseError); }
    try { new Notice(this.i18n.messages.alertPresentationFailed); } catch (noticeError) { console.error("Alarm and Timer could not show the alert presentation failure notice.", noticeError); }
    console.error("Alarm and Timer alert presentation failed.", error);
    queueMicrotask(() => this.showNext());
  }

  private finishCurrent(item: ScheduledItem, generation: number): void {
    if (!this.isPresentationCurrent(item, generation)) return;
    this.items.releaseAlert(item.id);
    this.activeItem = undefined;
    ++this.presentationGeneration;
    this.closeSystemNotification();
    this.audio.stop();
    const modal = this.activeModal;
    this.activeModal = undefined;
    modal?.close();
    this.showNext();
  }

  private releaseFailedClosedAlert(item: ScheduledItem, generation: number): void {
    if (!this.isPresentationCurrent(item, generation)) return;
    this.items.releaseAlert(item.id);
    this.activeItem = undefined;
    ++this.presentationGeneration;
    this.closeSystemNotification();
    this.audio.stop();
    this.activeModal = undefined;
    this.showNext();
  }

  private alertNotice(item: ScheduledItem): string {
    const label = item.label.trim();
    if (item.type === "alarm") return label === "" ? this.i18n.messages.alarmReady : this.i18n.messages.alarmReadyLabel(label);
    return label === "" ? this.i18n.messages.timerFinished : this.i18n.messages.timerFinishedLabel(label);
  }
}
