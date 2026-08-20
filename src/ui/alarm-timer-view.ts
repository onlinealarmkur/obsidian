import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE } from "../constants";
import type { I18n } from "../i18n";
import type { ItemService, ItemServiceEvent } from "../services/item-service";
import { compareScheduledItems } from "../services/scheduler-logic";
import type { ScheduledItem } from "../types";
import { displayLabel, formatDateTime, formatRemaining } from "../utils/formatting";
import { createAlarmForm, createTimerForm } from "./forms";
import { EditAlarmModal } from "./edit-alarm-modal";

type Tab = "alarm" | "timer";
const TABS: readonly Tab[] = ["alarm", "timer"];
const TAB_PANEL_ID = "online-alarm-timer-schedule-panel";
const HISTORY_PAGE_SIZE = 50;

interface RemainingEntry {
  readonly item: ScheduledItem;
  readonly element: HTMLElement;
}

interface AccessibleItemEntry {
  readonly item: ScheduledItem;
  readonly accessibleName: string;
}

export class AlarmTimerView extends ItemView {
  private activeTab: Tab = "alarm";
  private unsubscribe?: () => void;
  private readonly remainingEntries = new Map<string, RemainingEntry>();
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private formHost?: HTMLElement;
  private activeItemsHost?: HTMLElement;
  private activeSectionHeading?: HTMLElement;
  private completedItemsHost?: HTMLElement;
  private historySectionHeading?: HTMLElement;
  private visibleHistoryCount = HISTORY_PAGE_SIZE;
  private readonly actionControls = new Map<string, HTMLElement>();
  private renderQueued = false;
  private pendingFocus?: string;

  public constructor(leaf: WorkspaceLeaf, private readonly items: ItemService, private readonly i18n: I18n) { super(leaf); }
  public getViewType(): string { return VIEW_TYPE; }
  // The ampersand form is the required in-app panel heading.
  public getDisplayText(): string { return this.i18n.messages.productName; }
  public override getIcon(): string { return "alarm-clock"; }

  public override onOpen(): Promise<void> {
    this.visibleHistoryCount = HISTORY_PAGE_SIZE;
    this.containerEl.addClass("online-alarm-timer-view");
    this.unsubscribe = this.items.subscribe((event) => this.onServiceEvent(event));
    this.buildShell();
    this.renderForm();
    this.renderItems();
    return Promise.resolve();
  }

  public override onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.remainingEntries.clear();
    this.tabButtons.clear();
    this.formHost = undefined;
    this.activeItemsHost = undefined;
    this.activeSectionHeading = undefined;
    this.completedItemsHost = undefined;
    this.historySectionHeading = undefined;
    this.pendingFocus = undefined;
    return Promise.resolve();
  }

  private onServiceEvent(event: ItemServiceEvent): void {
    if (event === "data") this.scheduleRenderItems();
    else this.updateRemaining();
  }

  // A single alert lifecycle emits several data events in one burst; coalescing
  // them keeps one rebuild per burst instead of one per event.
  private scheduleRenderItems(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (this.activeItemsHost === undefined || this.completedItemsHost === undefined) return;
      this.renderItems();
    });
  }

  private controlKey(itemId: string, action: string): string {
    return `${itemId}|${action}`;
  }

  private restorePendingFocus(): void {
    const pending = this.pendingFocus;
    this.pendingFocus = undefined;
    if (pending === undefined) return;
    const exact = this.actionControls.get(pending);
    if (exact !== undefined) {
      exact.focus();
      return;
    }
    const itemId = pending.slice(0, pending.indexOf("|"));
    if (itemId !== "") {
      for (const [key, element] of this.actionControls) {
        if (key.startsWith(`${itemId}|`)) {
          element.focus();
          return;
        }
      }
    }
    if (itemId === "") {
      this.historySectionHeading?.focus();
      return;
    }
    const item = this.items.items.find((candidate) => candidate.id === itemId);
    if (item?.status === "completed" || item?.status === "missed" || item?.status === "cancelled") {
      this.historySectionHeading?.focus();
    } else {
      this.activeSectionHeading?.focus();
    }
  }

  private buildShell(): void {
    const content = this.contentEl;
    content.empty();
    this.tabButtons.clear();
    // The ampersand form is the required in-app panel heading.
    content.createEl("h2", { cls: "online-alarm-timer-heading", text: this.i18n.messages.productName });
    const tabs = content.createDiv({ cls: "online-alarm-timer-tabs", attr: { role: "tablist", "aria-label": this.i18n.messages.scheduleType } });
    for (const tab of TABS) {
      const button = tabs.createEl("button", {
        cls: "online-alarm-timer-tab",
        attr: {
          id: this.tabId(tab),
          role: "tab",
          "aria-controls": TAB_PANEL_ID,
          type: "button"
        },
        text: tab === "alarm" ? this.i18n.messages.alarm : this.i18n.messages.timer
      });
      button.addEventListener("click", () => this.selectTab(tab, false));
      button.addEventListener("keydown", (event) => this.onTabKeyDown(event, tab));
      this.tabButtons.set(tab, button);
    }
    this.formHost = content.createDiv({
      cls: "online-alarm-timer-tab-content",
      attr: { id: TAB_PANEL_ID, role: "tabpanel" }
    });
    this.activeItemsHost = content.createDiv({ cls: "online-alarm-timer-items-host", attr: { id: "online-alarm-timer-active-items" } });
    this.completedItemsHost = content.createDiv({ cls: "online-alarm-timer-items-host", attr: { id: "online-alarm-timer-completed-items" } });
    this.updateTabState();
  }

  private renderForm(): void {
    const host = this.formHost;
    if (host === undefined) return;
    host.empty();
    if (this.activeTab === "alarm") createAlarmForm(host, this.items, "online-alarm-timer-view-alarm", () => undefined, this.i18n);
    else createTimerForm(host, this.items, "online-alarm-timer-view-timer", () => undefined, this.i18n);
  }

  private renderItems(): void {
    const activeHost = this.activeItemsHost;
    const completedHost = this.completedItemsHost;
    if (activeHost === undefined || completedHost === undefined) return;
    activeHost.empty();
    completedHost.empty();
    this.remainingEntries.clear();
    this.actionControls.clear();
    const active = this.items.items
      .filter((item) => item.status === "active" || item.status === "paused" || item.status === "fired")
      .sort(compareScheduledItems);
    const completed = this.items.items
      .filter((item) => item.status === "completed" || item.status === "missed" || item.status === "cancelled")
      .sort((left, right) => {
        const timestampDifference = this.historyTimestamp(right) - this.historyTimestamp(left);
        return timestampDifference !== 0 ? timestampDifference : left.id.localeCompare(right.id);
      });
    const accessibleActive = this.withAccessibleNames(active);
    const accessibleCompleted = this.withAccessibleNames(completed.slice(0, this.visibleHistoryCount));
    const activeSection = activeHost.createEl("section", { cls: "online-alarm-timer-section" });
    this.activeSectionHeading = activeSection.createEl("h3", { attr: { tabindex: "-1" }, text: this.i18n.messages.active });
    if (accessibleActive.length === 0) activeSection.createEl("p", { cls: "online-alarm-timer-empty", text: this.i18n.messages.nothingScheduled });
    else for (const entry of accessibleActive) this.renderActiveItem(activeSection, entry.item, entry.accessibleName);

    const completedSection = completedHost.createEl("section", { cls: "online-alarm-timer-section" });
    const heading = completedSection.createDiv({ cls: "online-alarm-timer-section-heading" });
    this.historySectionHeading = heading.createEl("h3", { attr: { tabindex: "-1" }, text: this.i18n.messages.history });
    if (accessibleCompleted.length > 0) {
      const clear = heading.createEl("button", { attr: { type: "button" }, text: this.i18n.messages.clearHistory });
      clear.addEventListener("click", () => {
        const key = this.controlKey("", "clear-history");
        this.pendingFocus = key;
        void this.items.clearCompleted().catch(() => {
          if (this.pendingFocus === key) this.pendingFocus = undefined;
          new Notice(this.i18n.messages.historyClearFailed);
        });
      });
      for (const entry of accessibleCompleted) this.renderCompletedItem(completedSection, entry.item, entry.accessibleName);
      if (completed.length > accessibleCompleted.length) {
        const showMore = completedSection.createEl("button", {
          cls: "online-alarm-timer-show-more",
          attr: { type: "button" },
          text: this.i18n.messages.showMore
        });
        showMore.setAttribute("data-online-alarm-timer-action", "show-more");
        this.actionControls.set(this.controlKey("", "show-more"), showMore);
        showMore.addEventListener("click", () => {
          this.pendingFocus = this.controlKey("", "show-more");
          this.visibleHistoryCount += HISTORY_PAGE_SIZE;
          this.renderItems();
        });
      }
    } else {
      completedSection.createEl("p", { cls: "online-alarm-timer-empty", text: this.i18n.messages.noHistory });
    }
    this.updateRemaining();
    this.restorePendingFocus();
  }

  private selectTab(tab: Tab, focus: boolean): void {
    if (this.activeTab !== tab) {
      this.activeTab = tab;
      this.updateTabState();
      this.renderForm();
    }
    if (focus) this.tabButtons.get(tab)?.focus();
  }

  private updateTabState(): void {
    for (const tab of TABS) {
      const selected = tab === this.activeTab;
      const button = this.tabButtons.get(tab);
      if (button === undefined) continue;
      button.toggleClass("online-alarm-timer-tab-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    this.formHost?.setAttribute("aria-labelledby", this.tabId(this.activeTab));
  }

  private onTabKeyDown(event: KeyboardEvent, tab: Tab): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = TABS.indexOf(tab);
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + offset + TABS.length) % TABS.length;
    const nextTab = TABS[nextIndex];
    if (nextTab !== undefined) this.selectTab(nextTab, true);
  }

  private tabId(tab: Tab): string {
    return `online-alarm-timer-${tab}-tab`;
  }

  private renderActiveItem(parent: HTMLElement, item: ScheduledItem, accessibleName: string): void {
    const card = parent.createDiv({
      cls: "online-alarm-timer-card",
      attr: { role: "group", "aria-label": accessibleName }
    });
    const summary = card.createDiv({ cls: "online-alarm-timer-card-summary" });
    summary.createEl("strong", { text: displayLabel(item, this.i18n) });
    summary.createSpan({ cls: "online-alarm-timer-type", text: item.type === "alarm" ? this.i18n.messages.alarm : this.i18n.messages.timer });
    card.createDiv({
      cls: "online-alarm-timer-date",
      text: item.status === "paused"
        ? this.i18n.messages.paused
        : item.status === "fired"
          ? this.i18n.messages.alerting
          : formatDateTime(item.targetAt, this.items.settings.use24HourTime, this.i18n)
    });
    if (item.status === "fired") {
      card.createDiv({ cls: "online-alarm-timer-remaining", text: this.i18n.messages.alerting });
      return;
    }
    const remaining = card.createDiv({ cls: "online-alarm-timer-remaining", attr: { "aria-live": "off" } });
    this.remainingEntries.set(item.id, { item, element: remaining });
    const actions = card.createDiv({ cls: "online-alarm-timer-actions" });
    if (item.type === "alarm" && item.status === "active" && !this.items.isAlertReserved(item.id)) {
      const edit = actions.createEl("button", { attr: { type: "button", "aria-label": this.i18n.messages.actionAria(this.i18n.messages.edit, accessibleName) }, text: this.i18n.messages.edit });
      edit.addEventListener("click", () => new EditAlarmModal(this.app, this.items, item, this.i18n).open());
    }
    if (item.type === "timer" && (item.status === "active" || item.status === "paused")) {
      if (item.status === "paused") this.actionButton(actions, this.i18n.messages.resume, accessibleName, item.id, "resume", () => this.items.resumeTimer(item.id));
      else this.actionButton(actions, this.i18n.messages.pause, accessibleName, item.id, "pause", () => this.items.pauseTimer(item.id));
      this.actionButton(actions, this.i18n.messages.restart, accessibleName, item.id, "restart", () => this.items.restartTimer(item.id));
    }
    if (item.status === "active" || item.status === "paused") {
      this.actionButton(actions, this.i18n.messages.cancel, accessibleName, item.id, "cancel", () => this.items.cancel(item.id));
    }
  }

  private renderCompletedItem(parent: HTMLElement, item: ScheduledItem, accessibleName: string): void {
    const card = parent.createDiv({
      cls: "online-alarm-timer-card online-alarm-timer-card-completed",
      attr: { role: "group", "aria-label": accessibleName }
    });
    const summary = card.createDiv({ cls: "online-alarm-timer-card-summary" });
    summary.createEl("strong", { text: displayLabel(item, this.i18n) });
    summary.createSpan({ cls: "online-alarm-timer-state", text: item.status === "completed" ? this.i18n.messages.completed : item.status === "missed" ? this.i18n.messages.missed : this.i18n.messages.cancelled });
    card.createDiv({ cls: "online-alarm-timer-date", text: formatDateTime(item.targetAt, this.items.settings.use24HourTime, this.i18n) });
    if (item.type === "timer" && !this.items.isAlertReserved(item.id)) {
      const actions = card.createDiv({ cls: "online-alarm-timer-actions" });
      this.actionButton(actions, this.i18n.messages.restart, accessibleName, item.id, "restart", () => this.items.restartTimer(item.id));
    }
  }

  private actionButton(
    parent: HTMLElement,
    label: string,
    accessibleName: string,
    itemId: string,
    actionKey: string,
    action: () => Promise<void>
  ): void {
    const button = parent.createEl("button", {
      attr: {
        type: "button",
        "aria-label": this.i18n.messages.actionAria(label, accessibleName),
        "data-online-alarm-timer-item": itemId,
        "data-online-alarm-timer-action": actionKey
      },
      text: label
    });
    const key = this.controlKey(itemId, actionKey);
    this.actionControls.set(key, button);
    button.addEventListener("click", () => {
      this.pendingFocus = key;
      void action().catch(() => {
        if (this.pendingFocus === key) this.pendingFocus = undefined;
        new Notice(this.i18n.messages.itemUpdateFailed);
      });
    });
  }

  private accessibleItemName(item: ScheduledItem): string {
    const type = item.type === "alarm" ? this.i18n.messages.accessibleAlarm : this.i18n.messages.accessibleTimer;
    return item.label.trim() === "" ? type : `${displayLabel(item, this.i18n)} ${type}`;
  }

  private withAccessibleNames(items: readonly ScheduledItem[]): AccessibleItemEntry[] {
    const entries = items.map((item) => ({ item, baseName: this.accessibleItemName(item) }));
    const totals = new Map<string, number>();
    for (const { baseName } of entries) totals.set(baseName, (totals.get(baseName) ?? 0) + 1);
    const positions = new Map<string, number>();
    return entries.map(({ item, baseName }) => {
      const total = totals.get(baseName) ?? 1;
      if (total === 1) return { item, accessibleName: baseName };
      const position = (positions.get(baseName) ?? 0) + 1;
      positions.set(baseName, position);
      return { item, accessibleName: this.i18n.messages.duplicateItemAria(baseName, position, total) };
    });
  }

  private updateRemaining(): void {
    const now = Date.now();
    for (const { item, element } of this.remainingEntries.values()) {
      const remaining = item.type === "timer" && item.status === "paused" ? item.remainingMs : item.targetAt - now;
      const formatted = formatRemaining(remaining);
      element.setText(item.status === "paused" ? this.i18n.messages.remaining(formatted) : this.i18n.messages.inRemaining(formatted));
      element.setAttribute("aria-label", this.i18n.messages.itemRemainingAria(displayLabel(item, this.i18n), formatted));
    }
  }

  private historyTimestamp(item: ScheduledItem): number {
    return item.cancelledAt ?? item.completedAt ?? item.missedAt ?? item.targetAt;
  }
}
