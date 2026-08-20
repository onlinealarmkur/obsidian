import { Modal, type App } from "obsidian";
import type { I18n } from "../i18n";
import type { ItemService } from "../services/item-service";
import { createTimerForm } from "./forms";

export class TimerModal extends Modal {
  public constructor(app: App, private readonly items: ItemService, private readonly i18n: I18n) { super(app); }
  public override onOpen(): void {
    this.setTitle(this.i18n.messages.commandStartTimer);
    const form = createTimerForm(this.contentEl, this.items, "online-alarm-timer-modal-timer", () => this.close(), this.i18n);
    window.setTimeout(() => form.querySelector<HTMLInputElement>("input")?.focus(), 0);
  }
  public override onClose(): void { this.contentEl.empty(); }
}
