/**
 * MUGS — avatar renderer (DOM glue, no Obsidian import).
 *
 * Renders the shared avatar chip used across the views: an `<img>` when the
 * avatar resolved to a URL (falling back to initials if the image fails to
 * load), otherwise a deterministic initials chip. Kept Obsidian-import-free
 * like diffRender.ts, and safe under the view test shim's createEl helpers.
 */
import type { Avatar } from "./avatarModel";

/**
 * Append an avatar chip to `host`. Returns the chip element so callers can
 * position/annotate it. `opts.size` sets a square pixel size.
 */
export function renderAvatar(host: HTMLElement, avatar: Avatar, opts: { size?: number; title?: string } = {}): HTMLElement {
  const chip = host.createSpan({ cls: "mugs-avatar" });
  if (opts.size) {
    chip.style.width = `${opts.size}px`;
    chip.style.height = `${opts.size}px`;
  }
  chip.setAttribute("title", opts.title ?? avatar.name);

  if (avatar.url) {
    const img = chip.createEl("img", { cls: "mugs-avatar-img" });
    img.setAttribute("src", avatar.url);
    img.setAttribute("alt", avatar.name);
    img.setAttribute("loading", "lazy");
    // Never forward the vault/plugin context to a third-party avatar host.
    img.setAttribute("referrerpolicy", "no-referrer");
    img.addEventListener("error", () => {
      // Image failed (offline, private host): degrade to the initials chip.
      img.remove?.();
      chip.textContent = avatar.initials;
      chip.style.backgroundColor = avatar.color;
      chip.addClass?.("mugs-avatar-initials");
    });
    return chip;
  }

  chip.textContent = avatar.initials;
  chip.style.backgroundColor = avatar.color;
  chip.addClass("mugs-avatar-initials");
  return chip;
}

/** Avatar chip + a name label on one line (a "who did this" attribution). */
export function renderAvatarLabel(
  host: HTMLElement,
  avatar: Avatar,
  label: string = avatar.name,
  cls = "mugs-attribution",
): HTMLElement {
  const wrap = host.createSpan({ cls });
  renderAvatar(wrap, avatar, { size: 16 });
  wrap.createSpan({ cls: "mugs-attribution-name", text: label });
  return wrap;
}
