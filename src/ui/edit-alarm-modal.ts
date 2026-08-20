import { Modal, type App } from "obsidian";
import type { I18n } from "../i18n";
import type { ItemService } from "../services/item-service";
import type { AlarmItem } from "../types";
import { createEditAlarmForm } from "./forms";

export class EditAlarmModal extends Modal {
  public constructor(
    app: App,
    private readonly items: ItemService,
    private readonly item: AlarmItem,
    private readonly i18n: I18n
  ) {
    super(app);
  }

  public override onOpen(): void {
    this.modalEl.addClass("online-alarm-timer-edit-modal");
    this.setTitle(this.i18n.messages.editAlarm);
    const form = createEditAlarmForm(
      this.contentEl,
      this.items,
      this.item,
      "online-alarm-timer-edit-alarm",
      () => this.close(),
      this.i18n
    );
    window.setTimeout(() => form.querySelector<HTMLInputElement>("input")?.focus(), 0);
  }

  public override onClose(): void {
    this.contentEl.empty();
  }
}
