import { Modal, Notice, type App } from "obsidian";
import type { I18n } from "../i18n";
import type { ScheduledItem } from "../types";
import { displayLabel, formatDateTime } from "../utils/formatting";

interface AlertActions {
  stop: () => void | Promise<void>;
  restartTimer?: () => Promise<void>;
  releaseAfterClosedFailure?: () => void;
}

type AlertModalState = "idle" | "working" | "resolved";

export class AlertModal extends Modal {
  private state: AlertModalState = "idle";
  private closed = false;
  private actionGeneration = 0;
  private secondaryButton?: HTMLButtonElement;
  private stopButton?: HTMLButtonElement;

  public constructor(
    app: App,
    private readonly item: ScheduledItem,
    private readonly use24HourTime: boolean,
    private readonly actions: AlertActions,
    private readonly i18n: I18n
  ) {
    super(app);
  }

  public override onOpen(): void {
    this.closed = false;
    this.modalEl.addClass("online-alarm-timer-alert-modal");
    this.setTitle(this.item.type === "alarm" ? this.i18n.messages.alarm : this.i18n.messages.timer);
    const content = this.contentEl;
    content.createEl("p", { cls: "online-alarm-timer-alert-label", text: displayLabel(this.item, this.i18n) });
    const timeLabel = this.item.type === "alarm" ? this.i18n.messages.scheduledFor : this.i18n.messages.completedAt;
    content.createEl("p", { text: `${timeLabel} ${formatDateTime(this.item.targetAt, this.use24HourTime, this.i18n)}` });
    const actions = content.createDiv({ cls: "online-alarm-timer-actions" });
    if (this.item.type === "timer" && this.actions.restartTimer !== undefined) {
      this.secondaryButton = actions.createEl("button", { text: this.i18n.messages.restart });
      this.secondaryButton.addEventListener("click", () => {
        void this.perform(this.actions.restartTimer, this.i18n.messages.timerRestartFailed);
      });
    }
    this.stopButton = actions.createEl("button", { cls: "mod-cta", text: this.i18n.messages.stop });
    this.stopButton.addEventListener("click", () => this.stop());
    window.setTimeout(() => this.stopButton?.focus(), 0);
  }

  public stop(): void {
    void this.perform(this.actions.stop, this.i18n.messages.alertStopFailed);
  }

  public isIdle(): boolean {
    return this.state === "idle";
  }

  public closeResolved(): void {
    ++this.actionGeneration;
    this.state = "resolved";
    this.close();
  }

  public override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    if (this.state === "idle") this.stop();
  }

  private async perform(action: (() => void | Promise<void>) | undefined, failureMessage: string): Promise<void> {
    if (action === undefined) return;
    if (this.state !== "idle") return;
    const generation = ++this.actionGeneration;
    this.state = "working";
    this.setActionButtonsDisabled(true);
    try {
      await action();
      if (generation === this.actionGeneration) this.state = "resolved";
    } catch {
      if (generation !== this.actionGeneration) return;
      new Notice(failureMessage);
      if (this.closed) {
        this.state = "resolved";
        this.actions.releaseAfterClosedFailure?.();
        return;
      }
      this.state = "idle";
      this.setActionButtonsDisabled(false);
    }
  }

  private setActionButtonsDisabled(disabled: boolean): void {
    if (this.secondaryButton !== undefined) this.secondaryButton.disabled = disabled;
    if (this.stopButton !== undefined) this.stopButton.disabled = disabled;
  }
}
