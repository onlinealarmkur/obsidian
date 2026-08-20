import type { ScheduledItem } from "../types";
import type { I18n } from "../i18n";

export function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pair = (value: number): string => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pair(minutes)}:${pair(seconds)}` : `${pair(minutes)}:${pair(seconds)}`;
}

export function formatDateTime(timestamp: number, use24Hour: boolean, i18n: I18n): string {
  return i18n.formatDateTime(timestamp, use24Hour);
}

export function displayLabel(item: ScheduledItem, i18n: I18n): string {
  return i18n.displayLabel(item);
}
