import type { I18n } from "../i18n";
import { ItemService, type ItemServiceEvent } from "../services/item-service";
import { compareScheduledItems } from "../services/scheduler-logic";
import type { ScheduledItem } from "../types";
import { displayLabel, formatRemaining } from "../utils/formatting";

export class StatusBarController {
  private nextItem?: ScheduledItem;
  private started = false;
  private unsubscribe?: () => void;
  private visible = false;

  public constructor(
    private readonly element: HTMLElement,
    private readonly items: ItemService,
    private readonly i18n: I18n,
    private readonly openView: () => void
  ) {}

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.element.addClass("online-alarm-timer-status");
    this.element.setAttribute("role", "button");
    this.element.tabIndex = 0;
    this.element.addEventListener("click", this.handleClick);
    this.element.addEventListener("keydown", this.handleKeydown);
    this.unsubscribe = this.items.subscribe(this.handleItemServiceEvent);
    this.refreshData();
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.element.removeEventListener("click", this.handleClick);
    this.element.removeEventListener("keydown", this.handleKeydown);
  }

  private readonly handleClick = (): void => {
    if (this.started) this.openView();
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (!this.started || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    this.openView();
  };

  private readonly handleItemServiceEvent = (event: ItemServiceEvent): void => {
    if (!this.started) return;
    if (event === "data") this.refreshData();
    else this.updateCountdown();
  };

  private refreshData(): void {
    this.visible = this.items.settings.showStatusBar;
    let next: ScheduledItem | undefined;
    for (const item of this.items.items) {
      if (item.status !== "active") continue;
      if (next === undefined || compareScheduledItems(item, next) < 0) next = item;
    }
    this.nextItem = next;
    this.element.toggleClass("online-alarm-timer-hidden", !this.visible);
    this.updateCountdown();
  }

  private updateCountdown(): void {
    if (!this.visible) return;
    const next = this.nextItem;
    const text = next === undefined
      ? this.i18n.messages.noActiveItems
      : this.i18n.messages.statusRemaining(
          next.type === "alarm" ? this.i18n.messages.alarm : this.i18n.messages.timer,
          formatRemaining(next.targetAt - Date.now())
        );
    this.element.setText(text);
    const label = next === undefined ? text : this.i18n.messages.statusAccessible(displayLabel(next, this.i18n), text);
    this.element.setAttribute("aria-label", label);
    this.element.setAttribute("title", this.i18n.messages.statusTitle(label));
  }
}
