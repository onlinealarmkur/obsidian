import type { ScheduledItem } from "../types";

export interface SchedulerDecision {
  fire: ScheduledItem[];
  miss: ScheduledItem[];
}

export function earliestActiveTargetAt(items: readonly ScheduledItem[]): number | undefined {
  let earliest: number | undefined;
  for (const item of items) {
    if (item.status !== "active" || !Number.isFinite(item.targetAt)) continue;
    if (earliest === undefined || item.targetAt < earliest) earliest = item.targetAt;
  }
  return earliest;
}

export function decideDueItems(items: readonly ScheduledItem[], now: number, graceMs: number): SchedulerDecision {
  const fire: ScheduledItem[] = [];
  const miss: ScheduledItem[] = [];
  for (const item of items) {
    if (item.status !== "active" || item.targetAt > now) continue;
    if (now - item.targetAt <= graceMs) fire.push(item);
    else miss.push(item);
  }
  fire.sort(compareScheduledItems);
  miss.sort(compareScheduledItems);
  return { fire, miss };
}

export function compareScheduledItems(left: ScheduledItem, right: ScheduledItem): number {
  if (left.targetAt !== right.targetAt) return left.targetAt - right.targetAt;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
