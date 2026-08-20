import type { Plugin as ObsidianPlugin } from "obsidian";
import { describe, expect, it } from "vitest";
import { DataStore } from "../src/data/data-store";
import { DEFAULT_SETTINGS, type PluginData } from "../src/types";
import { getMockSavedData, Plugin, setMockPluginData } from "./mocks/obsidian";

describe("DataStore", () => {
  it("loads plugin data through migration and validation", async () => {
    const plugin = new Plugin();
    setMockPluginData(plugin, { settings: { volume: 25 }, items: [{ type: "alarm" }] });
    const store = new DataStore(plugin as unknown as ObsidianPlugin);

    await expect(store.load()).resolves.toEqual({
      schemaVersion: 2,
      settings: { ...DEFAULT_SETTINGS, volume: 25 },
      items: []
    });
  });

  it("passes the supplied snapshot to Plugin.saveData", async () => {
    const plugin = new Plugin();
    const store = new DataStore(plugin as unknown as ObsidianPlugin);
    const snapshot: PluginData = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS }, items: [] };

    await store.save(snapshot);

    expect(getMockSavedData(plugin)).toEqual([snapshot]);
    expect(getMockSavedData(plugin)[0]).toBe(snapshot);
  });

  it("rejects future schema data without validating or saving it", async () => {
    const plugin = new Plugin();
    const raw = { schemaVersion: 3, settings: { futureSetting: true }, items: [{ futureItem: true }] };
    setMockPluginData(plugin, raw);
    const store = new DataStore(plugin as unknown as ObsidianPlugin);

    await expect(store.load()).rejects.toMatchObject({
      name: "UnsupportedSchemaVersionError",
      storedVersion: 3,
      supportedVersion: 2
    });

    expect(getMockSavedData(plugin)).toEqual([]);
    expect(raw).toEqual({ schemaVersion: 3, settings: { futureSetting: true }, items: [{ futureItem: true }] });
  });
});
