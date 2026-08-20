import type { Plugin } from "obsidian";
import { Notice } from "obsidian";
import {
  LIVE_POLL_TOLERANCE_MS,
  MISSED_NOTICE_MAX_AGE_MS,
  SCHEDULER_INTERVAL_MS
} from "../constants";
import type { I18n } from "../i18n";
import type { ScheduledItem } from "../types";
import { displayLabel } from "../utils/formatting";
import type { AlertService } from "./alert-service";
import type { ItemService } from "./item-service";

export type SchedulerCheckOrigin = "catch-up" | "live-poll";

export class Scheduler {
  private checking = false;
  private started = false;
  private stopped = false;
  private generation = 0;
  private lastErrorNoticeAt = 0;

  public constructor(
    private readonly plugin: Plugin,
    private readonly items: ItemService,
    private readonly alerts: AlertService,
    private readonly i18n: I18n
  ) {}

  public start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.plugin.registerInterval(window.setInterval(() => { void this.check("live-poll"); }, SCHEDULER_INTERVAL_MS));
    this.plugin.registerDomEvent(window, "focus", () => { void this.check(); });
    this.plugin.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.check();
    });
    void this.check();
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    ++this.generation;
  }

  public async check(origin: SchedulerCheckOrigin = "catch-up"): Promise<void> {
    if (this.checking || this.stopped) return;
    this.checking = true;
    const generation = this.generation;
    try {
      const pending = this.items.pendingAlerts();
      if (!this.isCurrent(generation)) return;
      for (const item of pending) this.alerts.enqueue(item);
      const livePollToleranceMs = origin === "live-poll" ? LIVE_POLL_TOLERANCE_MS : 0;
      const { fired, missed } = await this.items.processDue(Date.now(), livePollToleranceMs);
      if (!this.isCurrent(generation)) return;
      const noticed = missed.filter((item) => this.shouldNoticeMissed(item));
      const [firstMissed] = noticed;
      if (noticed.length === 1 && firstMissed !== undefined) {
        new Notice(this.i18n.messages.missedWhileInactive(displayLabel(firstMissed, this.i18n)));
      } else if (noticed.length > 1) {
        new Notice(this.i18n.messages.missedManyWhileInactive(noticed.length));
      }
      for (const item of fired) this.alerts.enqueue(item);
      this.items.tick();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      const now = Date.now();
      if (now - this.lastErrorNoticeAt >= 60_000) {
        this.lastErrorNoticeAt = now;
        new Notice(this.i18n.messages.dataUpdateFailed);
        console.error("Alarm and Timer scheduler could not update stored data.", error);
      }
    } finally {
      this.checking = false;
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }

  private shouldNoticeMissed(item: ScheduledItem): boolean {
    if (item.missedAt === undefined) return false;
    const ageAtDetection = item.missedAt - item.targetAt;
    return ageAtDetection >= 0 && ageAtDetection <= MISSED_NOTICE_MAX_AGE_MS;
  }
}
