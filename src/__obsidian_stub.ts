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
      addOption: (value: string, text: string) => { const o = this.el.createEl("option", { text }); o.value = value; select.appendChild(o); return dd; },
      setDisabled: (d: boolean) => { select.disabled = d; return dd; },
    };
    cb(dd);
    return this;
  }
  addToggle(cb: (toggle: any) => void): this {
    const input = this.el.createEl("input", { type: "checkbox" });
    let onChangeCb: ((v: boolean) => void) | null = null;
    const tg = {
      value: false,
      setValue: (v: boolean) => { input.checked = v; return tg; },
      onChange: (cb: (v: boolean) => void) => { onChangeCb = cb; return tg; },
    };
    cb(tg);
    input.addEventListener("change", () => { if (onChangeCb) onChangeCb(input.checked); });
    return this;
  }
  addSlider(cb: (slider: any) => void): this { return this; }
  addButton(cb: (button: any) => void): this {
    const btn = document.createElement("button");
    let onClickCb: (() => void) | null = null;
    const b = { setButtonText: (_t: string) => { btn.textContent = _t; return b; }, setCta: () => b, setClass: () => b, setDisabled: (_d: boolean) => { btn.disabled = _d; return b }, onClick: (cb: () => void) => { onClickCb = cb; return b } };
    cb(b);
    btn.addEventListener("click", () => { if (onClickCb) onClickCb(); });
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
  private _handlers: Record<string, ((e: unknown) => void)[]> = {};
  parent: El | null = null;
  constructor(tag: string) { this.tagName = tag.toLowerCase(); }
  get className() { return [...this._classes].join(" "); }
  set className(v: string) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() { const set = this._classes; return { toggle: (c: string) => (set.has(c) ? set.delete(c) : set.add(c)), contains: (c: string) => set.has(c), add: (c: string) => set.add(c), remove: (c: string) => set.delete(c) }; }
  createDiv(opts?: { cls?: string }) { const e = new El("div"); if (opts?.cls) e.className = opts.cls; this.children.push(e); e.parent = this; return e; }
  createEl(tag: string, opts?: { text?: string; cls?: string; type?: string }) { const e = new El(tag); if (opts?.text != null) e.textContent = opts.text; if (opts?.cls) e.className = opts.cls; if (opts?.type) e.type = opts.type; this.children.push(e); e.parent = this; return e; }
  empty(): void { this.children = []; }
  appendChild(child: unknown) { this.children.push(child); (child as El).parent = this; return child; }
  remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    (this._handlers[type] ??= []).push(cb);
  }
  click(): void { this._handlers.click?.forEach((cb) => cb({ type: "click" })); if (this.tagName === "input" && this.type === "checkbox") this._handlers.change?.forEach((cb) => cb({ type: "change" })); }
  input(): void { this._handlers.input?.forEach((cb) => cb({ type: "input" })); }
  querySelectorAll(selector: string): unknown[] {
    const matches = (el: El) => {
      if (selector === "*") return true;
      if (selector.startsWith(".")) return el._classes.has(selector.slice(1));
    const attrRe = new RegExp('^\\w*\\[(\\w+)="([^"]*)"\\]$');
    const attrMatch = selector.match(attrRe);
      if (attrMatch) {
        const [, name, value] = attrMatch;
        if (name === "type") return el.type === value;
        if (name === "class") return el._classes.has(value);
        return false;
      }
      return false;
    };
    const out: unknown[] = [];
    const walk = (el: unknown) => {
      for (const c of (el as El).children ?? []) {
        if (matches(c as El)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): unknown {
    return this.querySelectorAll(selector)[0] ?? null;
  }
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
