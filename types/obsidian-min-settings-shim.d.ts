import "obsidian";

declare module "obsidian" {
  interface PluginSettingTab {
    getSettingDefinitions(): unknown[];
  }
}
