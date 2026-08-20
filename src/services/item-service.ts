import { Notice } from "obsidian";
import type { I18n } from "../i18n";
import type { DataStore } from "../data/data-store";
import { validateData } from "../data/validation";
import {
  LIVE_POLL_TOLERANCE_MS,
  MAX_DURATION_DAYS,
  MAX_DURATION_MS,
  MIN_TIMER_DURATION_MS
} from "../constants";
import type { AlarmItem, AlarmTimerSettings, PluginData, ScheduledItem, TimerItem } from "../types";
import { createId } from "../utils/ids";
import { resumedTargetAt, timerRemainingMs } from "../utils/date-time";
import { compareScheduledItems, decideDueItems, earliestActiveTargetAt } from "./scheduler-logic";

export type ItemServiceEvent = "data" | "tick";
export type ItemControlAction = "pause" | "resume" | "restart" | "cancel";
type Listener = (event: ItemServiceEvent) => void;

export interface ProcessedDueItems {
  fired: ScheduledItem[];
  missed: ScheduledItem[];
}

interface MutationResult<T> {
  changed: boolean;
  value: T;
}

export class ItemService {
  private readonly listeners = new Set<Listener>();
  private readonly alertReservations = new Set<string>();
  private cachedEarliestActiveTargetAt: number | undefined;
  private cachedFiredItems: readonly ScheduledItem[] = [];
  private cachedControllableItems: readonly ScheduledItem[] = [];
  private cachedHasHistory = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private pendingOperations = 0;

  public constructor(
    private readonly data: PluginData,
    private readonly store: Pick<DataStore, "save">,
    private readonly i18n: I18n
  ) {
    this.refreshCaches(data.items);
  }

  public get settings(): AlarmTimerSettings {
    return this.data.settings;
  }

  public get items(): readonly ScheduledItem[] {
    return this.data.items;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public tick(): void {
    this.emit("tick");
  }

  public reserveAlert(id: string): boolean {
    if (this.alertReservations.has(id)) return false;
    if (!this.cachedFiredItems.some((item) => item.id === id)) return false;
    this.alertReservations.add(id);
    this.emit("data");
    return true;
  }

  public releaseAlert(id: string): void {
    if (this.alertReservations.delete(id)) this.emit("data");
  }

  public isAlertReserved(id: string): boolean {
    return this.alertReservations.has(id);
  }

  public pendingAlerts(): ScheduledItem[] {
    return this.cachedFiredItems
      .filter((item) => !this.alertReservations.has(item.id))
      .map((item) => ({ ...item }));
  }

  public async addAlarm(targetAt: number, label: string): Promise<AlarmItem> {
    this.validateAlarmTimestamp(targetAt);
    return this.mutate((draft) => {
      const now = Date.now();
      const item: AlarmItem = { id: createId(), type: "alarm", label: label.trim(), createdAt: now, targetAt, status: "active" };
      draft.items.push(item);
      return { changed: true, value: item };
    });
  }

  public async addTimer(durationMs: number, label: string): Promise<TimerItem> {
    this.validateTimerDuration(durationMs);
    return this.mutate((draft) => {
      const now = Date.now();
      const item: TimerItem = { id: createId(), type: "timer", label: label.trim(), createdAt: now, targetAt: now + durationMs, durationMs, status: "active" };
      draft.items.push(item);
      return { changed: true, value: item };
    });
  }

  public async updateAlarm(id: string, targetAt: number, label: string): Promise<boolean> {
    this.validateAlarmTimestamp(targetAt);
    return this.mutate((draft) => {
      const item = draft.items.find((candidate) => candidate.id === id);
      if (item?.type !== "alarm" || item.status !== "active" || this.isAlertReserved(id)) {
        return { changed: false, value: false };
      }
      item.targetAt = targetAt;
      item.label = label.trim();
      return { changed: true, value: true };
    });
  }

  public findNextItem(action: ItemControlAction): ScheduledItem | undefined {
    for (const item of this.cachedControllableItems) {
      if (this.alertReservations.has(item.id) || !this.isEligibleForControl(item, action)) continue;
      return item;
    }
    return undefined;
  }

  public hasHistory(): boolean {
    return this.cachedHasHistory;
  }

  public async controlNextItem(action: ItemControlAction): Promise<boolean> {
    return this.mutate((draft) => {
      const item = this.findNextItemIn(draft.items, action);
      if (item === undefined) return { changed: false, value: false };
      const changed = this.applyControlAction(draft, item.id, action, false);
      return { changed, value: changed };
    });
  }

  public async pauseTimer(id: string): Promise<void> {
    await this.mutate((draft) => ({ changed: this.applyControlAction(draft, id, "pause", false), value: undefined }));
  }

  public async resumeTimer(id: string): Promise<void> {
    await this.mutate((draft) => ({ changed: this.applyControlAction(draft, id, "resume", false), value: undefined }));
  }

  public async restartTimer(id: string): Promise<void> {
    await this.mutate((draft) => ({ changed: this.applyControlAction(draft, id, "restart", true), value: undefined }));
  }

  public async cancel(id: string): Promise<void> {
    await this.mutate((draft) => ({ changed: this.applyControlAction(draft, id, "cancel", false), value: undefined }));
  }

  public async restartFiredTimer(id: string): Promise<boolean> {
    return this.mutate((draft) => {
      const itemIndex = this.timerIndex(draft, id);
      const item = itemIndex === -1 ? undefined : draft.items[itemIndex];
      if (item?.type !== "timer" || item.status !== "fired" || !this.isAlertReserved(id)) {
        return { changed: false, value: false };
      }
      draft.items[itemIndex] = {
        id: item.id,
        type: "timer",
        label: item.label,
        createdAt: item.createdAt,
        targetAt: Date.now() + item.durationMs,
        durationMs: item.durationMs,
        status: "active"
      };
      return { changed: true, value: true };
    });
  }

  public async acknowledgeFired(id: string): Promise<boolean> {
    return this.mutate((draft) => {
      const item = draft.items.find((candidate) => candidate.id === id);
      if (item?.status !== "fired" || !this.isAlertReserved(id)) {
        return { changed: false, value: false };
      }
      item.status = "completed";
      item.completedAt = Date.now();
      return { changed: true, value: true };
    });
  }

  public async clearCompleted(): Promise<void> {
    const removed = await this.mutate((draft) => {
      const before = draft.items.length;
      draft.items = draft.items.filter((item) =>
        item.status === "active" || item.status === "paused" || item.status === "fired"
      );
      return { changed: draft.items.length !== before, value: draft.items.length !== before };
    });
    if (!removed) {
      new Notice(this.i18n.messages.noHistoryToClear);
    }
  }

  public async updateSettings(update: Partial<AlarmTimerSettings>): Promise<void> {
    await this.mutate((draft) => {
      Object.assign(draft.settings, update);
      return { changed: true, value: undefined };
    });
  }

  public async waitForPendingDataWrites(): Promise<void> {
    let pendingWrites: Promise<void>;
    do {
      pendingWrites = this.mutationQueue;
      await pendingWrites;
    } while (pendingWrites !== this.mutationQueue);
  }

  public async processDue(now = Date.now(), livePollToleranceMs = 0): Promise<ProcessedDueItems> {
    if (this.pendingOperations === 0 && !this.isEarliestActiveTargetDue(now)) return { fired: [], missed: [] };
    return this.enqueueOperation(async () => {
      if (!this.isEarliestActiveTargetDue(now)) return { fired: [], missed: [] };
      return this.applyMutation((draft) => {
        const configuredGraceMs = draft.settings.overdueGraceMinutes * 60_000;
        const boundedLivePollToleranceMs = Number.isFinite(livePollToleranceMs)
          ? Math.min(Math.max(livePollToleranceMs, 0), LIVE_POLL_TOLERANCE_MS)
          : 0;
        const effectiveGraceMs = Math.max(configuredGraceMs, boundedLivePollToleranceMs);
        const decision = decideDueItems(draft.items, now, effectiveGraceMs);
        if (decision.fire.length === 0 && decision.miss.length === 0) return { changed: false, value: { fired: [], missed: [] } };
        for (const item of decision.fire) {
          item.status = "fired";
          item.firedAt = now;
        }
        for (const item of decision.miss) {
          item.status = "missed";
          item.missedAt = now;
        }
        return { changed: true, value: { fired: decision.fire, missed: decision.miss } };
      });
    });
  }

  private timerIndex(data: PluginData, id: string): number {
    return data.items.findIndex((candidate) => candidate.id === id && candidate.type === "timer");
  }

  private isEarliestActiveTargetDue(now: number): boolean {
    return this.cachedEarliestActiveTargetAt !== undefined && this.cachedEarliestActiveTargetAt <= now;
  }

  private findNextItemIn(items: readonly ScheduledItem[], action: ItemControlAction): ScheduledItem | undefined {
    let next: ScheduledItem | undefined;
    for (const item of items) {
      if (this.alertReservations.has(item.id) || !this.isEligibleForControl(item, action)) continue;
      if (next === undefined || compareScheduledItems(item, next) < 0) next = item;
    }
    return next;
  }

  private applyControlAction(
    draft: PluginData,
    id: string,
    action: ItemControlAction,
    allowCompletedRestart: boolean
  ): boolean {
    const itemIndex = action === "cancel"
      ? draft.items.findIndex((candidate) => candidate.id === id)
      : this.timerIndex(draft, id);
    const item = itemIndex === -1 ? undefined : draft.items[itemIndex];
    if (item === undefined) return false;

    if (action === "pause") {
      if (item.type !== "timer" || item.status !== "active") return false;
      draft.items[itemIndex] = { ...item, status: "paused", remainingMs: timerRemainingMs(item.targetAt, Date.now()) };
      return true;
    }

    if (action === "resume") {
      if (item.type !== "timer" || item.status !== "paused") return false;
      const { remainingMs, ...timerWithoutRemaining } = item;
      draft.items[itemIndex] = { ...timerWithoutRemaining, targetAt: resumedTargetAt(remainingMs, Date.now()), status: "active" };
      return true;
    }

    if (action === "restart") {
      if (item.type !== "timer") return false;
      if (!allowCompletedRestart && item.status !== "active" && item.status !== "paused") return false;
      if (allowCompletedRestart && item.status === "fired") return false;
      draft.items[itemIndex] = {
        id: item.id,
        type: "timer",
        label: item.label,
        createdAt: item.createdAt,
        targetAt: Date.now() + item.durationMs,
        durationMs: item.durationMs,
        status: "active"
      };
      return true;
    }

    if (item.status !== "active" && item.status !== "paused") return false;
    const cancelledAt = Date.now();
    if (item.type === "timer" && item.status === "paused") {
      draft.items[itemIndex] = {
        id: item.id,
        type: "timer",
        label: item.label,
        createdAt: item.createdAt,
        targetAt: item.targetAt,
        status: "cancelled",
        durationMs: item.durationMs,
        cancelledAt,
        ...(item.firedAt === undefined ? {} : { firedAt: item.firedAt }),
        ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
        ...(item.missedAt === undefined ? {} : { missedAt: item.missedAt })
      };
    } else {
      item.status = "cancelled";
      item.cancelledAt = cancelledAt;
    }
    return true;
  }

  private isEligibleForControl(item: ScheduledItem, action: ItemControlAction): boolean {
    if (action === "pause") return item.type === "timer" && item.status === "active";
    if (action === "resume") return item.type === "timer" && item.status === "paused";
    if (action === "restart") return item.type === "timer" && (item.status === "active" || item.status === "paused");
    return item.status === "active" || item.status === "paused";
  }

  private validateAlarmTimestamp(targetAt: number): void {
    if (!Number.isFinite(targetAt) || Number.isNaN(new Date(targetAt).getTime())) {
      throw new RangeError("Alarm time must be a valid timestamp.");
    }
  }

  private validateTimerDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < MIN_TIMER_DURATION_MS || durationMs > MAX_DURATION_MS) {
      throw new RangeError(`Timer duration must be between one second and ${MAX_DURATION_DAYS} days.`);
    }
  }

  private async mutate<T>(mutation: (draft: PluginData) => MutationResult<T>): Promise<T> {
    return this.enqueueOperation(() => this.applyMutation(mutation));
  }

  private async applyMutation<T>(mutation: (draft: PluginData) => MutationResult<T>): Promise<T> {
    const previous = validateData(this.data);
    const draft = validateData(previous);
    const result = mutation(draft);
    if (!result.changed) return result.value;
    const next = validateData(draft);
    try {
      await this.store.save(next);
    } catch (error) {
      this.replaceData(previous);
      throw error;
    }
    this.replaceData(next);
    this.emit("data");
    return result.value;
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations += 1;
    const pending = this.mutationQueue.then(operation);
    this.mutationQueue = pending.then(
      () => { this.pendingOperations -= 1; },
      () => { this.pendingOperations -= 1; }
    );
    return pending;
  }

  private replaceData(next: PluginData): void {
    this.data.schemaVersion = next.schemaVersion;
    this.data.settings = next.settings;
    this.data.items = next.items;
    this.refreshCaches(this.data.items);
  }

  private refreshCaches(items: readonly ScheduledItem[]): void {
    this.cachedEarliestActiveTargetAt = earliestActiveTargetAt(items);
    this.cachedFiredItems = items
      .filter((item) => item.status === "fired")
      .sort(compareScheduledItems);
    this.cachedControllableItems = items
      .filter((item) => item.status === "active" || item.status === "paused")
      .sort(compareScheduledItems);
    this.cachedHasHistory = items.some((item) =>
      item.status === "completed" || item.status === "missed" || item.status === "cancelled"
    );
  }

  private emit(event: ItemServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Alarm and Timer item listener failed.", error);
      }
    }
  }
}
