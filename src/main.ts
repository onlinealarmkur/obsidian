import { getLanguage, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { DataStore } from "./data/data-store";
import { InvalidSchemaVersionError, UnsupportedSchemaVersionError } from "./data/migrations";
import { VIEW_TYPE } from "./constants";
import { createI18n, type I18n } from "./i18n";
import { AlertService } from "./services/alert-service";
import { AudioService } from "./services/audio-service";
import { ItemService, type ItemControlAction } from "./services/item-service";
import { Scheduler } from "./services/scheduler";
import { AlarmModal } from "./ui/alarm-modal";
import { AlarmTimerView } from "./ui/alarm-timer-view";
import { AlarmTimerSettingTab } from "./ui/settings-tab";
import { StatusBarController } from "./ui/status-bar-controller";
import { TimerModal } from "./ui/timer-modal";
import type { PluginData } from "./types";

interface ControlCommandDefinition {
  readonly id: string;
  readonly name: string;
  readonly action: ItemControlAction;
  readonly emptyMessage: string;
  readonly failureMessage: string;
}

export default class AlarmTimerPlugin extends Plugin {
  private items?: ItemService;
  private audio?: AudioService;
  private alerts?: AlertService;
  private scheduler?: Scheduler;
  private statusBar?: StatusBarController;
  private quiesced = false;
  public i18n?: I18n;

  public override async onload(): Promise<void> {
    this.quiesced = false;
    this.i18n = createI18n(getLanguage());
    const i18n = this.i18n;
    const store = new DataStore(this);
    let data: PluginData;
    try {
      data = await store.load();
    } catch (error) {
      if (error instanceof UnsupportedSchemaVersionError) {
        new Notice(i18n.messages.schemaUnsupported(error.storedVersion, error.supportedVersion));
        return;
      }
      if (error instanceof InvalidSchemaVersionError) {
        new Notice(i18n.messages.schemaInvalid);
        return;
      }
      throw error;
    }
    this.items = new ItemService(data, store, i18n);
    this.audio = new AudioService();
    this.alerts = new AlertService(this.app, this.items, this.audio, () => this.openView(), i18n);
    this.scheduler = new Scheduler(this, this.items, this.alerts, i18n);
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new AlarmTimerView(leaf, this.requireItems(), i18n));
    this.addRibbonIcon("alarm-clock", i18n.messages.openRibbon, () => this.openViewWithFeedback());
    this.registerCommands();
    this.addSettingTab(new AlarmTimerSettingTab(this.app, this, this.items, this.audio, i18n));
    this.app.workspace.onLayoutReady(() => {
      if (this.quiesced) return;
      this.setupStatusBar();
      this.scheduler?.start();
    });
  }

  public override onunload(): void {
    this.quiesced = true;
    this.statusBar?.stop();
    this.scheduler?.stop();
    this.alerts?.stop();
    this.audio?.stop();
  }

  public async prepareForDataRestore(): Promise<void> {
    this.quiesced = true;
    this.scheduler?.stop();
    this.alerts?.stop();
    this.audio?.stop();
    await this.requireItems().waitForPendingDataWrites();
  }

  private registerCommands(): void {
    const { messages } = this.requireI18n();
    this.addCommand({ id: "open-view", name: messages.commandOpenSidebar, callback: () => this.openViewWithFeedback() });
    this.addCommand({ id: "set-alarm", name: messages.commandSetAlarm, callback: () => new AlarmModal(this.app, this.requireItems(), this.requireI18n()).open() });
    this.addCommand({ id: "start-timer", name: messages.commandStartTimer, callback: () => new TimerModal(this.app, this.requireItems(), this.requireI18n()).open() });
    this.addCommand({
      id: "dismiss-ringing-alert",
      name: messages.commandStopActiveAlert,
      checkCallback: (checking) => this.checkStopActiveAlertCommand(checking)
    });
    this.addCommand({
      id: "clear-completed-items",
      name: messages.commandClearHistory,
      checkCallback: (checking) => this.checkClearHistoryCommand(checking)
    });
    const controlCommands: readonly ControlCommandDefinition[] = [
      {
        id: "pause-next-active-timer",
        name: messages.commandPauseNextTimer,
        action: "pause",
        emptyMessage: messages.noActiveTimer,
        failureMessage: messages.timerPauseFailed
      },
      {
        id: "resume-next-paused-timer",
        name: messages.commandResumeNextTimer,
        action: "resume",
        emptyMessage: messages.noPausedTimer,
        failureMessage: messages.timerResumeFailed
      },
      {
        id: "restart-next-timer",
        name: messages.commandRestartNextTimer,
        action: "restart",
        emptyMessage: messages.noScheduledTimer,
        failureMessage: messages.timerRestartFailed
      },
      {
        id: "cancel-next-scheduled-item",
        name: messages.commandCancelNextItem,
        action: "cancel",
        emptyMessage: messages.noScheduledItem,
        failureMessage: messages.itemCancelFailed
      }
    ];
    for (const command of controlCommands) {
      this.addCommand({
        id: command.id,
        name: command.name,
        checkCallback: (checking) => this.checkControlNextItemCommand(
          command.action,
          command.emptyMessage,
          command.failureMessage,
          checking
        )
      });
    }
  }

  private checkStopActiveAlertCommand(checking: boolean): boolean {
    const alerts = this.requireAlerts();
    if (!alerts.hasActiveAlert()) return false;
    if (!checking) alerts.stopActive();
    return true;
  }

  private checkClearHistoryCommand(checking: boolean): boolean {
    if (this.quiesced) return false;
    const items = this.requireItems();
    if (!items.hasHistory()) return false;
    if (!checking) {
      this.runAction(() => items.clearCompleted(), this.requireI18n().messages.historyClearFailed);
    }
    return true;
  }

  private checkControlNextItemCommand(
    action: ItemControlAction,
    emptyMessage: string,
    failureMessage: string,
    checking: boolean
  ): boolean {
    if (this.quiesced) return false;
    if (this.requireItems().findNextItem(action) === undefined) return false;
    if (!checking) this.controlNextItem(action, emptyMessage, failureMessage);
    return true;
  }

  private controlNextItem(
    action: ItemControlAction,
    emptyMessage: string,
    failureMessage: string
  ): void {
    if (this.quiesced) return;
    void this.requireItems().controlNextItem(action).then(
      (controlled) => { if (!controlled) new Notice(emptyMessage); },
      () => { new Notice(failureMessage); }
    );
  }

  private openViewWithFeedback(): void {
    this.runAction(() => this.openView(), this.requireI18n().messages.viewOpenFailed);
  }

  private runAction(action: () => Promise<void>, failureMessage: string): void {
    void action().catch(() => new Notice(failureMessage));
  }

  private async openView(): Promise<void> {
    if (this.quiesced) return;
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      new Notice(this.requireI18n().messages.viewOpenFailed);
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    if (this.isUnloaded()) return;
    await this.app.workspace.revealLeaf(leaf);
  }

  private isUnloaded(): boolean {
    return this.quiesced;
  }

  private setupStatusBar(): void {
    const statusBar = new StatusBarController(
      this.addStatusBarItem(),
      this.requireItems(),
      this.requireI18n(),
      () => this.openViewWithFeedback()
    );
    this.statusBar = statusBar;
    this.register(() => statusBar.stop());
    statusBar.start();
  }

  private requireItems(): ItemService {
    if (this.items === undefined) throw new Error("Item service is not initialized.");
    return this.items;
  }

  private requireAlerts(): AlertService {
    if (this.alerts === undefined) throw new Error("Alert service is not initialized.");
    return this.alerts;
  }

  private requireI18n(): I18n {
    if (this.i18n === undefined) throw new Error("Localization is not initialized.");
    return this.i18n;
  }
}
