import { describe, expect, it } from "vitest";
import type { AlarmItem, TimerItem } from "../src/types";
import { decideDueItems, earliestActiveTargetAt } from "../src/services/scheduler-logic";

const alarm = (targetAt: number, status: AlarmItem["status"] = "active", id = String(targetAt), createdAt = 0): AlarmItem => ({
  id, type: "alarm", label: "", createdAt, targetAt, status
});

const pausedTimer = (targetAt: number): TimerItem => ({
  id: "paused",
  type: "timer",
  label: "",
  createdAt: 0,
  targetAt,
  status: "paused",
  durationMs: 60_000,
  remainingMs: 30_000
});

describe("scheduler decisions", () => {
  it("has no earliest active target for an empty collection", () => {
    expect(earliestActiveTargetAt([])).toBeUndefined();
  });

  it("ignores terminal history when finding the earliest active target", () => {
    expect(earliestActiveTargetAt([
      alarm(100, "fired"),
      alarm(50, "missed"),
      alarm(25, "cancelled")
    ])).toBeUndefined();
  });

  it("ignores paused timers when finding the earliest active target", () => {
    expect(earliestActiveTargetAt([pausedTimer(10)])).toBeUndefined();
  });

  it("finds the earliest finite active target in unsorted input", () => {
    expect(earliestActiveTargetAt([
      alarm(300),
      alarm(Number.POSITIVE_INFINITY),
      alarm(100),
      alarm(Number.NaN),
      alarm(200)
    ])).toBe(100);
  });

  it("returns an equal active target without depending on item order", () => {
    expect(earliestActiveTargetAt([
      alarm(100, "active", "z"),
      alarm(100, "active", "a")
    ])).toBe(100);
  });

  it("fires a delayed item once within grace", () => {
    const persisted = alarm(1_000);
    const first = decideDueItems([persisted], 5_000, 10_000);
    expect(first.fire).toHaveLength(1);
    persisted.status = "fired";
    expect(decideDueItems([persisted], 6_000, 10_000).fire).toHaveLength(0);
  });

  it("marks an item missed beyond grace after sleep", () => {
    expect(decideDueItems([alarm(1_000)], 20_000, 10_000).miss).toHaveLength(1);
  });

  it("treats the grace boundary as inclusive, including an exact zero-grace due time", () => {
    expect(decideDueItems([alarm(1_000)], 1_000, 0)).toMatchObject({ fire: [expect.objectContaining({ targetAt: 1_000 })], miss: [] });
    expect(decideDueItems([alarm(1_000)], 11_000, 10_000).fire).toHaveLength(1);
    expect(decideDueItems([alarm(1_000)], 11_001, 10_000).miss).toHaveLength(1);
  });

  it("orders fired and missed items chronologically without mutating persisted order", () => {
    const items = [
      alarm(900, "active", "fire-later", 1),
      alarm(100, "active", "miss-later", 2),
      alarm(800, "active", "fire-earlier", 3),
      alarm(50, "active", "miss-earlier", 4)
    ];

    const decision = decideDueItems(items, 1_000, 200);

    expect(decision.fire.map((item) => item.id)).toEqual(["fire-earlier", "fire-later"]);
    expect(decision.miss.map((item) => item.id)).toEqual(["miss-earlier", "miss-later"]);
    expect(items.map((item) => item.id)).toEqual(["fire-later", "miss-later", "fire-earlier", "miss-earlier"]);
  });

  it("breaks equal-target ties by creation time and then id", () => {
    const items = [
      alarm(1_000, "active", "z", 20),
      alarm(1_000, "active", "b", 10),
      alarm(1_000, "active", "a", 10)
    ];

    expect(decideDueItems(items, 1_000, 0).fire.map((item) => item.id)).toEqual(["a", "b", "z"]);
  });
});
