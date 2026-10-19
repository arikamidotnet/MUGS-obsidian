/**
 * Minimal stand-in for the `obsidian` package (which ships only .d.ts, no runtime JS).
 * Used by vitest via a resolve alias so DOM-dependent modules like settingsTab can be
 * unit-tested in the node environment. Not used by the production build.
 */

export class Notice {
  constructor(_message?: string, _timeout?: number) {}
  setMessage(_message: string): this { return this; }
}

/** Chainable stub of Obsidian's Setting builder — every method returns `this`. */
export class Setting {
  constructor(_containerEl: HTMLElement) {}
  setName(name: string): this { return this; }
  setDesc(desc: string): this { return this; }
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
}
