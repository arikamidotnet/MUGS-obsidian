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
  addText(cb: (text: any) => void): this {
    const input = this.el.createEl("input", { type: "text" });
    const tc = { inputEl: input, setPlaceholder: (p: string) => { input.placeholder = p; return tc; }, setValue: (v: string) => { input.value = v; return tc; }, onChange: (_cb: (v: string) => void) => tc };
    cb(tc);
    return this;
  }
  addTextArea(cb: (text: any) => void): this {
    const ta = this.el.createEl("textarea");
    const tc = { inputEl: ta, setPlaceholder: (p: string) => { ta.placeholder = p; return tc; }, setValue: (v: string) => { ta.value = v; return tc; }, onChange: (_cb: (v: string) => void) => tc };
    cb(tc);
    return this;
  }
  addDropdown(cb: (dropdown: any) => void): this {
    const select = this.el.createEl("select");
    const dd = {
      selectEl: select,
      setValue: (v: string) => { select.value = v; return dd; },
      onChange: (_cb: (v: string) => void) => dd,
      addOption: (value: string, text: string) => { const o = document.createElement("option"); o.value = value; o.textContent = text; select.appendChild(o); return dd; },
      setDisabled: (d: boolean) => { select.disabled = d; return dd; },
    };
    cb(dd);
    return this;
  }
  addToggle(cb: (toggle: any) => void): this {
    const input = this.el.createEl("input", { type: "checkbox" });
    const tg = { value: false, setValue: (v: boolean) => { input.checked = v; return tg; }, onChange: (_cb: (v: boolean) => void) => tg };
    cb(tg);
    return this;
  }
  addSlider(cb: (slider: any) => void): this { return this; }
  addButton(cb: (button: any) => void): this {
    const btn = { setButtonText: (_t: string) => btn, setCta: () => btn, setClass: () => btn, setDisabled: (_d: boolean) => btn, onClick: (_cb: () => void) => btn };
    cb(btn);
    return this;
  }
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

/** Framework-wrapped element with Obsidian's DOM helpers (createDiv/createEl/etc.).
 *  Mirrors how the real framework provides containerEl — unlike a bare
 *  document.createElement("div") from user code, which lacks these helpers. */
class El {
  tagName: string;
  textContent = "";
  children: unknown[] = [];
  _classes = new Set<string>();
  options: unknown[] = [];
  value = "";
  placeholder = "";
  rows = 0;
  type = "";
  checked = false;
  disabled = false;
  innerHTML = "";
  style: Record<string, string> = {};
  constructor(tag: string) { this.tagName = tag.toLowerCase(); }
  get className() { return [...this._classes].join(" "); }
  set className(v: string) { this._classes = new Set(v.split(/\s+/).filter(Boolean)); }
  createDiv(opts?: { cls?: string }) { const e = new El("div"); if (opts?.cls) e.className = opts.cls; this.children.push(e); return e; }
  createEl(tag: string, opts?: { text?: string; cls?: string; type?: string }) { const e = new El(tag); if (opts?.text != null) e.textContent = opts.text; if (opts?.cls) e.className = opts.cls; if (opts?.type) e.type = opts.type; this.children.push(e); return e; }
  appendChild(child: unknown) { this.children.push(child); if ((child as { tagName?: string }).tagName === "option" && Array.isArray(this.options)) this.options.push(child); return child; }
  remove() {}
  empty() { this.children = []; }
  addEventListener() {}
  get classList() { const set = this._classes; return { toggle: (c: string) => (set.has(c) ? set.delete(c) : set.add(c)), contains: (c: string) => set.has(c), add: (c: string) => set.add(c), remove: (c: string) => set.delete(c) }; }
}
export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: HTMLElement;
  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new El("div") as unknown as HTMLElement; // test seam: known DOM element shape
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
