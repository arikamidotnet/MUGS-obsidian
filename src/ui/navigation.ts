import { getMugsContext } from "./dataSources";

export type MugsViewId = "mugs-map" | "mugs-diff" | "mugs-reconciliation" | "mugs-conflicts";

/** A small, consistent way between the MUGS pages. */
export function renderNavigation(host: HTMLElement, active: MugsViewId): void {
  const actions = getMugsContext().actions;
  if (!actions) return;
  const nav = host.createEl("nav", { cls: "mugs-navigation", attr: { "aria-label": "MUGS pages" } });
  for (const [view, label] of [
    ["mugs-map", "Overview"],
    ["mugs-diff", "Changes"],
    ["mugs-reconciliation", "Review"],
    ["mugs-conflicts", "Conflicts"],
  ] as const) {
    const button = nav.createEl("button", { type: "button", text: label });
    if (view === active) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => actions.openView(view));
  }
}
