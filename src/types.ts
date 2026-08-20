export type ItemStatus = "active" | "paused" | "fired" | "completed" | "missed" | "cancelled";
export type AlarmItemStatus = Exclude<ItemStatus, "paused">;
export type NonPausedItemStatus = Exclude<ItemStatus, "paused">;

interface ScheduledItemBase<TStatus extends ItemStatus> {
  id: string;
  label: string;
  createdAt: number;
  targetAt: number;
  status: TStatus;
  firedAt?: number;
  completedAt?: number;
  missedAt?: number;
  cancelledAt?: number;
}

export interface AlarmItem extends ScheduledItemBase<AlarmItemStatus> {
  type: "alarm";
}

interface TimerItemBase {
  type: "timer";
  durationMs: number;
}

export type TimerItem =
  | (ScheduledItemBase<"paused"> & TimerItemBase & { remainingMs: number })
  | (ScheduledItemBase<NonPausedItemStatus> & TimerItemBase & { remainingMs?: never });

export type ScheduledItem = AlarmItem | TimerItem;

export interface AlarmTimerSettings {
  defaultTimerMinutes: number;
  quickTimerMinutes: number[];
  use24HourTime: boolean;
  showStatusBar: boolean;
  enableSound: boolean;
  volume: number;
  enableSystemNotifications: boolean;
  overdueGraceMinutes: number;
}

export interface PluginData {
  schemaVersion: number;
  settings: AlarmTimerSettings;
  items: ScheduledItem[];
}

export const DEFAULT_SETTINGS: AlarmTimerSettings = {
  defaultTimerMinutes: 10,
  quickTimerMinutes: [1, 5, 10, 15, 30, 60],
  use24HourTime: false,
  showStatusBar: true,
  enableSound: true,
  volume: 70,
  enableSystemNotifications: false,
  overdueGraceMinutes: 15
};

export const DEFAULT_DATA: PluginData = {
  schemaVersion: 2,
  settings: DEFAULT_SETTINGS,
  items: []
};
