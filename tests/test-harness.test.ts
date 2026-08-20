import { beforeEach, describe, expect, it } from "vitest";
import { Notice, Platform } from "obsidian";
import { getRecordedNotices, resetRecordedNotices } from "./mocks/obsidian";

describe("Obsidian test harness", () => {
  beforeEach(() => resetRecordedNotices());

  it("resolves the test-only alias and records notices deterministically", () => {
    new Notice("Ready", 2_000);

    expect(getRecordedNotices()).toEqual([{ message: "Ready", timeout: 2_000 }]);
    expect(Platform.isDesktop).toBe(true);
  });
});
