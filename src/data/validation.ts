import { DEFAULT_DATA, DEFAULT_SETTINGS, type AlarmItemStatus, type AlarmTimerSettings, type ItemStatus, type NonPausedItemStatus, type PluginData, type ScheduledItem } from "../types";
import {
  MAX_DURATION_MS,
  MAX_LABEL_LENGTH,
  MAX_OVERDUE_GRACE_MINUTES,
  MAX_QUICK_TIMER_DURATIONS,
  MAX_TIMER_MINUTES,
  MAX_VOLUME,
  MIN_OVERDUE_GRACE_MINUTES,
  MIN_TIMER_DURATION_MS,
  MIN_TIMER_MINUTES,
  MIN_VOLUME,
  SCHEMA_VERSION
} from "../constants";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRenderableTimestamp(value: unknown): value is number {
  return finiteNumber(value) && !Number.isNaN(new Date(value).getTime());
}

function isItemStatus(value: unknown): value is ItemStatus {
  return value === "active" || value === "paused" || value === "fired" || value === "completed" || value === "missed" || value === "cancelled";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeQuickTimerMinutes(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.quickTimerMinutes];
  const minutes: number[] = [];
  const seen = new Set<number>();
  for (const candidate of value) {
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < MIN_TIMER_MINUTES || candidate > MAX_TIMER_MINUTES || seen.has(candidate)) continue;
    seen.add(candidate);
    minutes.push(candidate);
    if (minutes.length === MAX_QUICK_TIMER_DURATIONS) break;
  }
  return minutes.length > 0 ? minutes : [...DEFAULT_SETTINGS.quickTimerMinutes];
}

function validateSettings(value: unknown): AlarmTimerSettings {
  const source = isRecord(value) ? value : {};
  return {
    defaultTimerMinutes: finiteNumber(source.defaultTimerMinutes) ? clamp(Math.round(source.defaultTimerMinutes), MIN_TIMER_MINUTES, MAX_TIMER_MINUTES) : DEFAULT_SETTINGS.defaultTimerMinutes,
    quickTimerMinutes: normalizeQuickTimerMinutes(source.quickTimerMinutes),
    use24HourTime: typeof source.use24HourTime === "boolean" ? source.use24HourTime : DEFAULT_SETTINGS.use24HourTime,
    showStatusBar: typeof source.showStatusBar === "boolean" ? source.showStatusBar : DEFAULT_SETTINGS.showStatusBar,
    enableSound: typeof source.enableSound === "boolean" ? source.enableSound : DEFAULT_SETTINGS.enableSound,
    volume: finiteNumber(source.volume) ? clamp(source.volume, MIN_VOLUME, MAX_VOLUME) : DEFAULT_SETTINGS.volume,
    enableSystemNotifications: typeof source.enableSystemNotifications === "boolean" ? source.enableSystemNotifications : false,
    overdueGraceMinutes: finiteNumber(source.overdueGraceMinutes) ? clamp(Math.round(source.overdueGraceMinutes), MIN_OVERDUE_GRACE_MINUTES, MAX_OVERDUE_GRACE_MINUTES) : DEFAULT_SETTINGS.overdueGraceMinutes
  };
}

function validateItem(value: unknown): ScheduledItem | undefined {
  if (!isRecord(value)) return undefined;
  const validType = value.type === "alarm" || value.type === "timer";
  if (!validType || !isItemStatus(value.status) || typeof value.id !== "string" || value.id.trim().length === 0 || !isRenderableTimestamp(value.createdAt) || !isRenderableTimestamp(value.targetAt)) return undefined;
  const status = value.status;
  const base = {
    id: value.id,
    type: value.type,
    label: typeof value.label === "string" ? value.label.slice(0, MAX_LABEL_LENGTH) : "",
    createdAt: value.createdAt,
    targetAt: value.targetAt,
    status,
    ...(isRenderableTimestamp(value.firedAt) ? { firedAt: value.firedAt } : {}),
    ...(isRenderableTimestamp(value.completedAt) ? { completedAt: value.completedAt } : {}),
    ...(isRenderableTimestamp(value.missedAt) ? { missedAt: value.missedAt } : {}),
    ...(isRenderableTimestamp(value.cancelledAt) ? { cancelledAt: value.cancelledAt } : {})
  };
  if (value.type === "timer") {
    if (!finiteNumber(value.durationMs) || value.durationMs < MIN_TIMER_DURATION_MS || value.durationMs > MAX_DURATION_MS) return undefined;
    if (status === "paused") {
      if (!finiteNumber(value.remainingMs) || value.remainingMs < 0 || value.remainingMs > MAX_DURATION_MS) return undefined;
      return { ...base, type: "timer", status: "paused", durationMs: value.durationMs, remainingMs: value.remainingMs };
    }
    const nonPausedStatus: NonPausedItemStatus = status;
    return { ...base, type: "timer", status: nonPausedStatus, durationMs: value.durationMs };
  }
  if (status === "paused") return undefined;
  const alarmStatus: AlarmItemStatus = status;
  return { ...base, type: "alarm", status: alarmStatus };
}

export function validateData(value: unknown): PluginData {
  if (!isRecord(value)) {
    return {
      schemaVersion: DEFAULT_DATA.schemaVersion,
      settings: { ...DEFAULT_DATA.settings, quickTimerMinutes: [...DEFAULT_DATA.settings.quickTimerMinutes] },
      items: []
    };
  }
  const items: ScheduledItem[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(value.items)) {
    for (const candidate of value.items) {
      const item = validateItem(candidate);
      if (item === undefined || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      items.push(item);
    }
  }
  return { schemaVersion: SCHEMA_VERSION, settings: validateSettings(value.settings), items };
}
