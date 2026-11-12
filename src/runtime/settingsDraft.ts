/**
 * MUGS — settings draft/Apply model (U04).
 *
 * The old settings tab mutated the LIVE store on every keystroke/toggle and only
 * deferred the on-disk write — so half-applied settings (a mapping pointing at a
 * not-yet-added credential, an overlapping folder pair) were already driving the
 * scheduler and sync engine before the user ever clicked Apply.
 *
 * This controller flips the model:
 *  - edits accumulate in an in-memory DRAFT (structuredClone of the active settings);
 *  - Apply validates the COMPLETE draft (traversal, overlap, .obsidian, credential shape);
 *  - commit applies the draft onto the store through the EXISTING setter API
 *    (store.ts is not modified), then persists ONCE via store.save();
 *  - a refused/failed save ROLLS BACK the store to the pre-apply snapshot, so the
 *    active settings are intact and the user sees the failure (contract §10);
 *  - Cancel discards the draft entirely.
 */
import type { MugsSettings, FolderMapping, Credential, SyncPolicy, Agent, StagedChange, FileConflict } from "../types";
import { checkRelPath, segmentsOf } from "../git/safePath";

/** Minimal store surface the draft commits through (mirrors MugsStore's setters). */
export interface SettingsDraftTarget {
  getSettings(): MugsSettings;
  upsertCredential(input: Credential): unknown;
  removeCredential(id: string): void;
  upsertMapping(mapping: FolderMapping): unknown;
  removeMapping(id: string): void;
  setSecurity(partial: Partial<MugsSettings["security"]>): void;
  setSync(partial: Partial<SyncPolicy>): void;
  setObsidianConfig(config: MugsSettings["sync"]["obsidianConfig"]): void;
  save(): Promise<{ ok: true } | { ok: false; reason: "load-error" }>;
}

/** A settings edit session. */
export class SettingsDraft {
  /** Snapshot of the ACTIVE settings when the draft opened (rollback source). */
  readonly base: MugsSettings;
  /** Working copy all edits land in. */
  private working: MugsSettings;

  constructor(current: MugsSettings) {
    this.base = structuredClone(current);
    this.working = structuredClone(current);
  }

  /** A copy of the working settings for rendering (never hand out the live object). */
  view(): MugsSettings {
    return structuredClone(this.working);
  }

  /** True when the draft differs from the base snapshot (cheap field-wise compare). */
  dirty(): boolean {
    return JSON.stringify(this.working) !== JSON.stringify(this.base);
  }

  // --- Mutators (mirror the store API so call sites read the same) ------------

  upsertCredential(input: Credential): void {
    this.working.credentials = this.working.credentials.filter((c) => c.id !== input.id);
    this.working.credentials.push(structuredClone(input));
  }

  removeCredential(id: string): void {
    this.working.credentials = this.working.credentials.filter((c) => c.id !== id);
  }

  upsertMapping(mapping: FolderMapping): void {
    this.working.mappings = this.working.mappings.filter((m) => m.id !== mapping.id);
    this.working.mappings.push(structuredClone(mapping));
  }

  removeMapping(id: string): void {
    this.working.mappings = this.working.mappings.filter((m) => m.id !== id);
  }

  setSecurity(partial: Partial<MugsSettings["security"]>): void {
    this.working.security = { ...this.working.security, ...partial };
  }

  setSync(partial: Partial<SyncPolicy>): void {
    this.working.sync = { ...this.working.sync, ...partial };
  }

  setObsidianConfig(config: MugsSettings["sync"]["obsidianConfig"]): void {
    this.working.sync.obsidianConfig = { ...this.working.sync.obsidianConfig, ...config };
  }

  setObsidianConfigEnabled(enabled: boolean): void {
    this.working.sync.obsidianConfig = { ...this.working.sync.obsidianConfig, enabled };
  }

  // --- Validation -------------------------------------------------------------

  /**
   * Validate the COMPLETE draft. Returns human-readable problems (empty = valid).
   * Rules (contract §5/§9/§10):
   *  - every mapping's localFolder is a safe vault-relative path (or the whole-vault ".");
   *  - every non-empty remotePath is a safe repo-relative path;
   *  - every branch (when present) is a plausible ref name is NOT enforced here
   *    (the store/driver reject at use) — kept out to avoid over-blocking;
   *  - no two mappings claim the same localFolder;
   *  - no mapping's localFolder nests inside another's (overlap);
   *  - every mapping points at an existing credential;
   *  - every credential has label + token (schema enforces shape on save; surface early).
   */
  validate(): string[] {
    const problems: string[] = [];
    const mappings = this.working.mappings;

    for (const m of mappings) {
      if (m.localFolder !== ".") {
        const check = checkRelPath(m.localFolder);
        if (!check.ok) {
          problems.push(`mapping "${m.label || m.id}": local folder "${m.localFolder}" rejected (${check.reason})`);
        }
      }
      if (m.remotePath !== "") {
        const check = checkRelPath(m.remotePath);
        if (!check.ok) {
          problems.push(`mapping "${m.label || m.id}": remote path "${m.remotePath}" rejected (${check.reason})`);
        }
      }
      if (!this.working.credentials.some((c) => c.id === m.providerId)) {
        problems.push(`mapping "${m.label || m.id}": credential missing — add or pick one before applying`);
      }
    }

    for (let i = 0; i < mappings.length; i++) {
      for (let j = i + 1; j < mappings.length; j++) {
        const a = normalizeFolder(mappings[i].localFolder);
        const b = normalizeFolder(mappings[j].localFolder);
        if (a === b) {
          problems.push(`mappings "${mappings[i].label || mappings[i].id}" and "${mappings[j].label || mappings[j].id}" map the same folder "${mappings[i].localFolder}"`);
          continue;
        }
        if (contains(a, b) || contains(b, a)) {
          problems.push(`mappings "${mappings[i].label || mappings[i].id}" (${a}) and "${mappings[j].label || mappings[j].id}" (${b}) overlap — one folder is inside the other`);
        }
      }
    }

    for (const c of this.working.credentials) {
      if (!c.label) problems.push(`credential ${c.id}: label is required`);
      if (!c.token) problems.push(`credential "${c.label || c.id}": token is required`);
    }

    return problems;
  }

  /**
   * Commit the draft onto the store: validate → apply via setters → save ONCE.
   * On a failed/refused save the store is rolled back to the pre-commit snapshot
   * so the ACTIVE settings stay intact (contract §10). Returns the problems
   * (validation aborted, nothing applied) or the SaveResult.
   */
  async commit(store: SettingsDraftTarget): Promise<{ kind: "invalid"; problems: string[] } | { kind: "saved" } | { kind: "save-failed"; result: { ok: false; reason: "load-error" } }> {
    const problems = this.validate();
    if (problems.length > 0) return { kind: "invalid", problems };

    // Snapshot the store's CURRENT settings for rollback (may differ from base
    // if another component wrote since the draft opened).
    const rollback: MugsSettings = structuredClone(store.getSettings());
    try {
      applySnapshot(store, this.working);
    } catch (err) {
      // Applying must never half-land; restore and report.
      applySnapshot(store, rollback);
      return { kind: "save-failed", result: { ok: false, reason: "load-error" } };
    }
    const result = await store.save();
    if (!result.ok) {
      // Failed save leaves the ACTIVE settings intact — roll the store back.
      applySnapshot(store, rollback);
      return { kind: "save-failed", result };
    }
    return { kind: "saved" };
  }
}

/** "." and "" normalize to the whole-vault root; otherwise trimmed slashes. */
function normalizeFolder(folder: string): string {
  const f = folder.trim();
  if (f === "" || f === ".") return ".";
  return f.replace(/^\/+|\/+$/g, "");
}

/** Segment-wise containment (never string prefixes). Both args pre-normalized. */
function contains(root: string, target: string): boolean {
  if (root === target) return false; // equality handled separately
  if (root === ".") return true;     // whole vault contains everything
  if (target === ".") return false;
  const rs = segmentsOf(root);
  const ts = segmentsOf(target);
  if (ts.length < rs.length) return false;
  for (let i = 0; i < rs.length; i++) if (ts[i] !== rs[i]) return false;
  return true;
}

/**
 * Make the store's settings equal `snapshot` using ONLY the setter API:
 * upsert everything present, remove ids absent. lastSync/conflicts/staging/agents
 * are not draft-editable and are left untouched.
 */
function applySnapshot(store: SettingsDraftTarget, snapshot: MugsSettings): void {
  const cur = store.getSettings();

  // Credentials: remove dropped; upsert ONLY new/changed ones. Re-upserting an
  // UNCHANGED credential is not a no-op on the real store — upsertCredential
  // overwrites the runtime (decrypted) token with the stored form, which for an
  // encrypted vault means poisoning the runtime token with ciphertext. Skipping
  // untouched credentials keeps those runtime tokens intact.
  const curCreds = new Map(cur.credentials.map((c) => [c.id, c]));
  const snapCredIds = new Set(snapshot.credentials.map((c) => c.id));
  for (const id of curCreds.keys()) if (!snapCredIds.has(id)) store.removeCredential(id);
  for (const c of snapshot.credentials) {
    const before = curCreds.get(c.id);
    if (before && JSON.stringify(before) === JSON.stringify(c)) continue;
    store.upsertCredential(structuredClone(c));
  }

  // Mappings: remove dropped, upsert all (mapping upsert has no runtime side effects).
  const curMapIds = new Set(cur.mappings.map((m) => m.id));
  for (const m of snapshot.mappings) curMapIds.delete(m.id);
  for (const id of curMapIds) store.removeMapping(id);
  for (const m of snapshot.mappings) store.upsertMapping(structuredClone(m));

  store.setSecurity(structuredClone(snapshot.security));
  store.setSync(structuredClone(snapshot.sync));
  store.setObsidianConfig(structuredClone(snapshot.sync.obsidianConfig));
}

// Type re-exports for consumers (no runtime cost).
export type { MugsSettings, FolderMapping, Credential, Agent, StagedChange, FileConflict };
