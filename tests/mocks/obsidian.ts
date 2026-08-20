interface ElementOptions {
  attr?: Record<string, string | number>;
  cls?: string;
  text?: string;
}

export class MockEvent {
  public defaultPrevented = false;

  public constructor(public readonly key = "") {}

  public preventDefault(): void {
    this.defaultPrevented = true;
  }
}

export class MockElement {
  public readonly children: MockElement[] = [];
  public readonly classes = new Set<string>();
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: MockEvent) => void)[]>();
  public defaultValue = "";
  public disabled = false;
  public focused = false;
  public id = "";
  public max = "";
  public maxLength = 0;
  public min = "";
  public placeholder = "";
  public required = false;
  public step = "";
  public tabIndex = 0;
  public text = "";
  public type = "";
  public value = "";

  public constructor(public readonly tagName = "div") {}

  public addClass(className: string): void {
    for (const name of className.split(/\s+/).filter(Boolean)) this.classes.add(name);
  }

  public removeClass(className: string): void {
    this.classes.delete(className);
  }

  public toggleClass(className: string, enabled: boolean): void {
    if (enabled) this.addClass(className);
    else this.removeClass(className);
  }

  public createDiv(options: ElementOptions = {}): MockElement {
    return this.createEl("div", options);
  }

  public createSpan(options: ElementOptions = {}): MockElement {
    return this.createEl("span", options);
  }

  public createEl(tagName: string, options: ElementOptions = {}): MockElement {
    const child = new MockElement(tagName);
    child.text = options.text ?? "";
    if (options.cls !== undefined) child.addClass(options.cls);
    for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, String(value));
    this.children.push(child);
    return child;
  }

  public addEventListener(type: string, listener: (event: MockEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: MockEvent) => void): void {
    const listeners = this.listeners.get(type);
    if (listeners === undefined) return;
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  public empty(): void {
    this.children.length = 0;
    this.text = "";
  }

  public focus(): void {
    this.focused = true;
  }

  public querySelector(selector: string): MockElement | null {
    const match = this.findDescendant((element) => selector === element.tagName || selector === `#${element.id}`);
    return match ?? null;
  }

  public dispatch(type: string, event = new MockEvent()): MockEvent {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  public getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  public reset(): void {
    this.resetInputs();
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
    if (name === "type") this.type = value;
    if (name === "value") {
      this.value = value;
      this.defaultValue = value;
    }
    if (name === "tabindex") this.tabIndex = Number(value);
  }

  public setText(text: string): void {
    this.text = text;
  }

  private resetInputs(): void {
    if (this.tagName === "input") this.value = this.defaultValue;
    for (const child of this.children) child.resetInputs();
  }

  private findDescendant(predicate: (element: MockElement) => boolean): MockElement | undefined {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const match = child.findDescendant(predicate);
      if (match !== undefined) return match;
    }
    return undefined;
  }
}

function findElementByText(element: MockElement, text: string): MockElement | undefined {
  if (element.text === text) return element;
  for (const child of element.children) {
    const match = findElementByText(child, text);
    if (match !== undefined) return match;
  }
  return undefined;
}

export function clickMockElementByText(root: unknown, text: string): boolean {
  if (!(root instanceof MockElement)) return false;
  const element = findElementByText(root, text);
  if (element === undefined) return false;
  element.dispatch("click");
  return true;
}

export function findMockElementByClass(root: unknown, className: string): MockElement | undefined {
  if (!(root instanceof MockElement)) return undefined;
  if (root.classes.has(className)) return root;
  for (const child of root.children) {
    const match = findMockElementByClass(child, className);
    if (match !== undefined) return match;
  }
  return undefined;
}

export function findMockElementById(root: unknown, id: string): MockElement | undefined {
  if (!(root instanceof MockElement)) return undefined;
  if (root.id === id) return root;
  for (const child of root.children) {
    const match = findMockElementById(child, id);
    if (match !== undefined) return match;
  }
  return undefined;
}

export function dispatchMockKeyboardById(root: unknown, id: string, key: string): MockEvent | undefined {
  const element = findMockElementById(root, id);
  return element?.dispatch("keydown", new MockEvent(key));
}

export function getMockElementTexts(root: unknown): string[] {
  if (!(root instanceof MockElement)) return [];
  return [root.text, ...root.children.flatMap((child) => getMockElementTexts(child))].filter((text) => text.length > 0);
}

export interface RecordedNotice {
  message: string;
  timeout?: number;
}

const notices: RecordedNotice[] = [];
let language = "en";

export function getLanguage(): string {
  return language;
}

export function setMockLanguage(nextLanguage: string): void {
  language = nextLanguage;
}

export function resetMockLanguage(): void {
  language = "en";
}

export class Notice {
  public constructor(message: string, timeout?: number) {
    notices.push(timeout === undefined ? { message } : { message, timeout });
  }

  public hide(): void {
    return;
  }
}

export function getRecordedNotices(): readonly RecordedNotice[] {
  return notices;
}

export function resetRecordedNotices(): void {
  notices.length = 0;
}

const modals: Modal[] = [];
let nextModalOpenError: Error | undefined;

export function failNextModalOpen(error: Error): void {
  nextModalOpenError = error;
}

export class Modal {
  public readonly contentEl = new MockElement();
  public readonly modalEl = new MockElement();
  public closeCount = 0;
  public isOpen = false;
  public openCount = 0;
  public title = "";

  public constructor(public readonly app: unknown) {
    modals.push(this);
  }

  public open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    ++this.openCount;
    this.onOpen();
    if (nextModalOpenError !== undefined) {
      const error = nextModalOpenError;
      nextModalOpenError = undefined;
      throw error;
    }
  }

  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    ++this.closeCount;
    this.onClose();
  }

  public onOpen(): void {
    return;
  }

  public onClose(): void {
    return;
  }

  public setTitle(title: string): this {
    this.title = title;
    return this;
  }
}

export function getCreatedModals(): readonly Modal[] {
  return modals;
}

export function resetCreatedModals(): void {
  modals.length = 0;
  nextModalOpenError = undefined;
}

export const Platform = {
  isAndroidApp: false,
  isDesktop: true,
  isDesktopApp: true,
  isIosApp: false,
  isMacOS: false,
  isMobile: false,
  isMobileApp: false,
  isPhone: false,
  isSafari: false,
  isTablet: false,
  isWin: false
};

export class ItemView {
  public readonly containerEl = new MockElement();
  public readonly contentEl = new MockElement();

  public constructor(public readonly leaf: unknown) {}
}

export interface MockCommand {
  id: string;
  name: string;
  callback?: () => void;
  checkCallback?: (checking: boolean) => boolean;
}

export function isMockCommandAvailable(command: MockCommand): boolean {
  if (command.checkCallback !== undefined) return command.checkCallback(true);
  return command.callback !== undefined;
}

export function executeMockCommand(command: MockCommand): boolean {
  if (command.checkCallback !== undefined) {
    if (!command.checkCallback(true)) return false;
    return command.checkCallback(false);
  }
  if (command.callback === undefined) return false;
  command.callback();
  return true;
}

export interface MockPluginState {
  readonly commands: MockCommand[];
  readonly registeredCallbacks: (() => void)[];
  readonly registeredDomEvents: { target: unknown; type: string; callback: EventListenerOrEventListenerObject }[];
  readonly registeredIntervals: number[];
  readonly ribbonIcons: { icon: string; title: string; callback: () => void }[];
  readonly settingTabs: PluginSettingTab[];
  readonly statusBarItems: MockElement[];
  readonly views: { type: string; creator: (leaf: unknown) => unknown }[];
}

export class MockWorkspace {
  public readonly layoutReadyCallbacks: (() => void)[] = [];
  public readonly revealedLeaves: unknown[] = [];
  public readonly leavesByType = new Map<string, unknown[]>();
  public rightLeaf: unknown = null;

  public getLeavesOfType(type: string): unknown[] {
    return this.leavesByType.get(type) ?? [];
  }

  public getRightLeaf(_split: boolean): unknown {
    return this.rightLeaf;
  }

  public onLayoutReady(callback: () => void): void {
    this.layoutReadyCallbacks.push(callback);
  }

  public revealLeaf(leaf: unknown): Promise<void> {
    this.revealedLeaves.push(leaf);
    return Promise.resolve();
  }

  public triggerLayoutReady(): void {
    for (const callback of this.layoutReadyCallbacks) callback();
  }
}

export class MockApp {
  public readonly workspace = new MockWorkspace();
}

export class Plugin {
  public readonly app: MockApp;
  public readonly manifest: { version: string };
  public mockData: unknown = null;
  public readonly mockSavedData: unknown[] = [];
  private readonly mockState: MockPluginState = {
    commands: [],
    registeredCallbacks: [],
    registeredDomEvents: [],
    registeredIntervals: [],
    ribbonIcons: [],
    settingTabs: [],
    statusBarItems: [],
    views: []
  };

  public constructor(app = new MockApp(), manifest = { version: "1.0.0" }) {
    this.app = app;
    this.manifest = manifest;
  }

  public addCommand(command: MockCommand): MockCommand {
    this.mockState.commands.push(command);
    return command;
  }

  public addRibbonIcon(icon: string, title: string, callback: () => void): MockElement {
    this.mockState.ribbonIcons.push({ icon, title, callback });
    return new MockElement();
  }

  public addSettingTab(tab: PluginSettingTab): void {
    this.mockState.settingTabs.push(tab);
  }

  public addStatusBarItem(): MockElement {
    const element = new MockElement();
    this.mockState.statusBarItems.push(element);
    return element;
  }

  public register(callback: () => void): void {
    this.mockState.registeredCallbacks.push(callback);
  }

  public registerInterval(intervalId: number): number {
    this.mockState.registeredIntervals.push(intervalId);
    return intervalId;
  }

  public registerDomEvent(
    element: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject
  ): void {
    this.mockState.registeredDomEvents.push({ target: element, type, callback });
  }

  public registerEvent<T>(eventRef: T): T {
    return eventRef;
  }

  public registerView(type: string, creator: (leaf: unknown) => unknown): void {
    this.mockState.views.push({ type, creator });
  }

  public loadData(): Promise<unknown> {
    return Promise.resolve(this.mockData);
  }

  public saveData(data: unknown): Promise<void> {
    this.mockSavedData.push(data);
    return Promise.resolve();
  }

  public getMockState(): MockPluginState {
    return this.mockState;
  }
}

export function getMockPluginState(plugin: unknown): MockPluginState {
  if (!(plugin instanceof Plugin)) throw new TypeError("Expected the Obsidian Plugin mock.");
  return plugin.getMockState();
}

export function getMockWorkspace(plugin: unknown): MockWorkspace {
  if (!(plugin instanceof Plugin)) throw new TypeError("Expected the Obsidian Plugin mock.");
  return plugin.app.workspace;
}

export function setMockPluginData(plugin: unknown, data: unknown): void {
  if (!(plugin instanceof Plugin)) throw new TypeError("Expected the Obsidian Plugin mock.");
  plugin.mockData = data;
}

export function getMockSavedData(plugin: unknown): readonly unknown[] {
  if (!(plugin instanceof Plugin)) throw new TypeError("Expected the Obsidian Plugin mock.");
  return plugin.mockSavedData;
}

export class PluginSettingTab {
  public readonly containerEl = new MockElement();

  public constructor(public readonly app: unknown, public readonly plugin: Plugin) {}

  public display(): void {
    return;
  }

  public hide(): void {
    return;
  }
}

type ChangeHandler<T> = (value: T) => void | Promise<void>;

export class TextComponent {
  public readonly inputEl = new MockElement("input");
  public value = "";
  private changeHandler?: ChangeHandler<string>;

  public setValue(value: string): this {
    this.value = value;
    this.inputEl.value = value;
    return this;
  }

  public onChange(handler: ChangeHandler<string>): this {
    this.changeHandler = handler;
    return this;
  }

  public async trigger(value: string): Promise<void> {
    this.value = value;
    this.inputEl.value = value;
    await this.changeHandler?.(value);
  }
}

export class ToggleComponent {
  public value = false;
  private changeHandler?: ChangeHandler<boolean>;

  public setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  public onChange(handler: ChangeHandler<boolean>): this {
    this.changeHandler = handler;
    return this;
  }

  public async trigger(value: boolean): Promise<void> {
    this.value = value;
    await this.changeHandler?.(value);
  }
}

export class SliderComponent {
  public limits?: { minimum: number; maximum: number; step: number };
  public value = 0;
  private changeHandler?: ChangeHandler<number>;

  public setLimits(minimum: number, maximum: number, step: number): this {
    this.limits = { minimum, maximum, step };
    return this;
  }

  public setValue(value: number): this {
    this.value = value;
    return this;
  }

  public onChange(handler: ChangeHandler<number>): this {
    this.changeHandler = handler;
    return this;
  }

  public async trigger(value: number): Promise<void> {
    this.value = value;
    await this.changeHandler?.(value);
  }
}

export class ButtonComponent {
  public buttonText = "";
  private clickHandler?: () => void | Promise<void>;

  public setButtonText(text: string): this {
    this.buttonText = text;
    return this;
  }

  public onClick(handler: () => void | Promise<void>): this {
    this.clickHandler = handler;
    return this;
  }

  public async trigger(): Promise<void> {
    await this.clickHandler?.();
  }
}

const settings: Setting[] = [];

export class Setting {
  public name = "";
  public description = "";
  public heading = false;
  public readonly texts: TextComponent[] = [];
  public readonly toggles: ToggleComponent[] = [];
  public readonly sliders: SliderComponent[] = [];
  public readonly buttons: ButtonComponent[] = [];

  public constructor(public readonly containerEl: unknown) {
    settings.push(this);
  }

  public setName(name: string): this {
    this.name = name;
    return this;
  }

  public setDesc(description: string): this {
    this.description = description;
    return this;
  }

  public setHeading(): this {
    this.heading = true;
    return this;
  }

  public addText(callback: (component: TextComponent) => void): this {
    const component = new TextComponent();
    this.texts.push(component);
    callback(component);
    return this;
  }

  public addToggle(callback: (component: ToggleComponent) => void): this {
    const component = new ToggleComponent();
    this.toggles.push(component);
    callback(component);
    return this;
  }

  public addSlider(callback: (component: SliderComponent) => void): this {
    const component = new SliderComponent();
    this.sliders.push(component);
    callback(component);
    return this;
  }

  public addButton(callback: (component: ButtonComponent) => void): this {
    const component = new ButtonComponent();
    this.buttons.push(component);
    callback(component);
    return this;
  }
}

export function getCreatedSettings(): readonly Setting[] {
  return settings;
}

export function getSettingByName(name: string): Setting | undefined {
  return settings.find((setting) => setting.name === name);
}

export function resetCreatedSettings(): void {
  settings.length = 0;
}
