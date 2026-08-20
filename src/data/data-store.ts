import type { Plugin } from "obsidian";
import type { PluginData } from "../types";
import { migrateData } from "./migrations";
import { validateData } from "./validation";

export class DataStore {
  public constructor(private readonly plugin: Plugin) {}

  public async load(): Promise<PluginData> {
    const raw: unknown = await this.plugin.loadData();
    return validateData(migrateData(raw));
  }

  public async save(data: PluginData): Promise<void> {
    await this.plugin.saveData(data);
  }
}
