/**
 * Minimal stand-in for the `obsidian` package (which ships only .d.ts, no runtime JS).
 * Used by vitest via a resolve alias so DOM-dependent modules like settingsTab can be
 * unit-tested in the node environment. Not used by the production build.
 */

export class Notice {
  constructor(_message?: string, _timeout?: number) {}
  setMessage(_message: string): this { return this; }
}

/** Chainable stub of Obsidian's Setting builder — every method returns `this`.
 *  setName/setDesc render into the container (label + description nodes) so DOM-
 *  dependent modules can be asserted on, mirroring real Obsidian behaviour. */
export class Setting {
  private el: HTMLElement;
  constructor(containerEl: HTMLElement) { this.el = containerEl; }
  setName(name: string): this { const d = this.el.createDiv(); d.textContent = String(name); return this; }
  setDesc(desc: string): this { const d = this.el.createDiv({ cls: "setting-desc" }); d.textContent = String(desc); return this; }
  addExtraButton(cb: (button: any) => void): this { return this; }
  addText(cb: (text: any) => void): this { return this; }
  addTextArea(cb: (text: any) => void): this { return this; }
  addToggle(cb: (toggle: any) => void): this { return this; }
  addSlider(cb: (slider: any) => void): this { return this; }
  addButton(cb: (button: any) => void): this { return this; }
  addColorPicker(cb: (picker: any) => void): this { return this; }
  addField(_label: string, _input: HTMLElement): this { return this; }
  setClass(_cls: string): this { return this; }
}

/** Minimal base-class stub of Obsidian's ItemView — provides contentEl + the
 *  view lifecycle hooks the MUGS views override. Kept so diff/map/review views can
 *  be driven under vitest via the resolve alias. */
export class ItemView {
  app: any;
  workspace: any;
  contentEl: HTMLElement;
  constructor(_leaf?: any) { this.contentEl = document.createElement("div"); }
  getViewType(): string { return ""; }
  getDisplayText(): string { return ""; }
  getIcon(): string { return ""; }
  addAction(_name: string, _title: string, _cb?: () => void): any { return {}; }
  onOpen(): Promise<void> { return Promise.resolve(); }
  onClose(): Promise<void> { return Promise.resolve(); }
}

/** Base class stub mirroring the parts PluginSettingTab relies on. */
export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: HTMLElement;
  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }
  hide(): void {}
  /** Mirror Obsidian 1.13+: the base reads this.plugin.settings and returns a
   *  declarative definition set. MUGS stores settings in plugin.store, so with no
   *  plugin.settings present it still yields a non-empty scaffold — which is exactly
   *  what makes Obsidian render declaratively and skip display() (the blank-settings bug). */
  getSettingDefinitions(): any[] {
    const s = this.plugin && this.plugin.settings;
    if (!s) return [{ name: "MUGS (declarative fallback)" }];
    return Object.keys(s).map((k: string) => ({ name: k }));
  }
}
