/**
 * MUGS — manual conflict resolution transaction (contract §5, S07).
 *
 * One module owns the WHOLE resolution transaction so the UI can never half-apply
 * one: identity check → operation lock → recoverable originals written (clone +
 * vault + trash) BEFORE any mutation → clone write → vault write → state clear →
 * `store.save()`. A refused save (`SaveResult.ok === false`) is a FAILURE — the
 * conflict is retained durably so nothing is lost; a mid-way failure leaves a
 * durable retry record (the conflict stays + a failed pendingOps entry).
 *
 * Single-flight: a second resolution never starts while one is in flight — the
 * caller (diff-ui) disables the whole action group until the promise settles;
 * this module ALSO enforces the lock internally so any two callers serialize.
 *
 * The shared contract type `ConflictResolver` is `(c, choice) => Promise<ResolveOutcome>`;
 * since a conflict record does not carry its mapping id, bind one resolver per
 * mapping via {@link ConflictResolverFactory.forMapping}.
 */
import type { FileConflict, ResolveOutcome, PendingOperation } from "../types";
import type { ResolveChoice } from "../sync/conflict";
import type { SaveResult } from "../store";
import type { WorkingTreeWriter } from "../sync/cloneManager";
import type { TrashStore } from "../sync/trash";
import { resolveConflictFile } from "../sync/conflict";
import { checkRelPath } from "../git/safePath";

/** Everything the transaction needs — inject fakes in tests, concrete in main.ts. */
export interface ConflictResolverDeps {
  /** Look up the CURRENT stored conflicts for identity/version checking. */
  getConflicts: (mappingId: string) => FileConflict[];
  /** Look up the mapping (must still exist) — drives path mapping + clone dir. */
  getMapping: (mappingId: string) =>
    | { id: string; localFolder: string; repoRef?: string; providerId: string }
    | undefined;
  /** Absolute clone dir for the mapping (cloneDir(...) in main.ts). */
  cloneDirFor: (mappingId: string) => string;
  /** Write/read/delete inside the CLONE working tree (absolute paths). */
  cloneTree: WorkingTreeWriter;
  /** Write/read/delete inside the VAULT (absolute paths). */
  vaultTree: WorkingTreeWriter;
  /** Map a repo-relative path to a vault-absolute path (undefined when unmappable). */
  vaultAbsPath: (mappingId: string, repoRelPath: string) => string | undefined;
  /** Recoverable-deletion log (records BEFORE any delete mutation). */
  trash: TrashStore;
  /** Persist state changes; its SaveResult decides success (contract §10). */
  save: () => Promise<SaveResult>;
  /** Replace the conflict list for a mapping after a successful clear. */
  setConflicts: (mappingId: string, conflicts: FileConflict[]) => void;
  /** Record a durable retry entry when the transaction fails mid-way (never dropped). */
  recordRetry?: (mappingId: string, op: PendingOperation) => void;
  /** Epoch source (injectable for tests). */
  now?: () => number;
}

/** Bindable per-mapping resolver (the contract surface diff-ui consumes). */
export interface ConflictResolverFactory {
  /** The ConflictResolver for one mapping's conflicts (contract §5 signature). */
  forMapping(mappingId: string): (c: FileConflict, choice: ResolveChoice) => Promise<ResolveOutcome>;
}

/** Build the resolver factory handed to diff-ui through the context (contract §5). */
export function createConflictResolver(deps: ConflictResolverDeps): ConflictResolverFactory {
  // Single-flight lock across ALL mappings: a manual resolution is a global
  // transaction on the shared store, so one lock is the conservative correct choice.
  let inFlight: Promise<ResolveOutcome> | undefined;

  const guard = (run: () => Promise<ResolveOutcome>): Promise<ResolveOutcome> => {
    if (inFlight) {
      return Promise.resolve({
        ok: false,
        error: "another resolution is already running — wait for it to finish",
        retryable: true,
      });
    }
    inFlight = run().finally(() => { inFlight = undefined; });
    return inFlight;
  };

  return {
    forMapping(mappingId: string) {
      return (conflict: FileConflict, choice: ResolveChoice) =>
        guard(() => runTransaction(mappingId, conflict, choice, deps));
    },
  };
}

async function runTransaction(
  mappingId: string,
  conflict: FileConflict,
  choice: ResolveChoice,
  deps: ConflictResolverDeps,
): Promise<ResolveOutcome> {
  const now = deps.now ?? Date.now;
  const mapping = deps.getMapping(mappingId);
  if (!mapping) {
    return { ok: false, error: `mapping ${mappingId} not found`, retryable: false };
  }

  // --- Identity check (contract §5): mapping/path/conflict-version must match. ---
  const stored = deps.getConflicts(mappingId).find((c) => c.path === conflict.path);
  if (!stored) {
    return { ok: false, error: `conflict at ${conflict.path} no longer exists (already resolved?)`, retryable: false };
  }
  if (stored.resolved) {
    return { ok: false, error: `conflict at ${conflict.path} was already resolved`, retryable: false };
  }
  // Stale-render guard: if the caller rendered an older version, reject as retryable.
  if (conflictVersionOf(conflict) !== conflictVersionOf(stored)) {
    return { ok: false, error: `conflict at ${conflict.path} changed since it was displayed — retry`, retryable: true };
  }

  // safePath validation BEFORE any use of the path in file ops (contract §9).
  try { checkRelPath(conflict.path); } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: false };
  }

  // Compute the resolved content up-front so originals can be staged first.
  // The pre-transaction list is captured so a refused save can restore it exactly
  // (the conflict must STAY when the resolution is not durably acknowledged).
  const beforeList = deps.getConflicts(mappingId);
  const next = resolveConflictFile(beforeList, conflict.path, choice);
  if (!next) {
    return { ok: false, error: `no conflict at ${conflict.path}`, retryable: false };
  }

  const cloneAbs = `${deps.cloneDirFor(mappingId)}/${conflict.path}`;
  const vaultAbs = deps.vaultAbsPath(mappingId, conflict.path);

  // WorkingTreeWriter's readFile/deleteFile are optional seams — normalize locally.
  const readTree = async (tree: typeof deps.cloneTree, abs: string): Promise<string | undefined> =>
    tree.readFile ? await tree.readFile(abs) : undefined;
  const deleteFrom = async (tree: typeof deps.cloneTree, abs: string): Promise<void> => {
    if (tree.deleteFile) await tree.deleteFile(abs);
  };

  try {
    // --- Recoverable originals BEFORE mutation (clone + vault + trash). ---
    const cloneOriginal = await readTree(deps.cloneTree, cloneAbs);
    deps.trash.trash(mappingId, conflict.path, cloneOriginal);
    if (vaultAbs) {
      const vaultOriginal = await readTree(deps.vaultTree, vaultAbs);
      deps.trash.trash(`${mappingId}:vault`, conflict.path, vaultOriginal);
      if (vaultOriginal !== undefined) {
        await deps.vaultTree.writeFile(`${vaultAbs}.mugs-origin`, vaultOriginal);
      }
    }
    if (cloneOriginal !== undefined) {
      await deps.cloneTree.writeFile(`${cloneAbs}.mugs-origin`, cloneOriginal);
    }

    // --- Mutations in contract order: clone write → vault write. ---
    const deletion =
      (choice === "ours" && stored.oursAbsent === true) ||
      (choice === "theirs" && stored.theirsAbsent === true);
    if (deletion) {
      await deleteFrom(deps.cloneTree, cloneAbs);
      if (vaultAbs) await deleteFrom(deps.vaultTree, vaultAbs);
    } else {
      await deps.cloneTree.writeFile(cloneAbs, next.resolvedContent);
      if (vaultAbs) await deps.vaultTree.writeFile(vaultAbs, next.resolvedContent);
    }

    // --- State clear → save(): a refused save is a FAILURE (contract §10). ---
    deps.setConflicts(mappingId, next.conflicts);
    const saveResult = await deps.save();
    if (!saveResult.ok) {
      // The conflict STAYS (contract §5): restore the exact pre-transaction list so
      // the unresolved conflict is not lost to a failed persist, and record a durable
      // retry op. The working-tree/vault writes stand (recoverable via .mugs-origin
      // files) but the resolution is not acknowledged.
      deps.setConflicts(mappingId, beforeList);
      recordRetry(deps, mappingId, conflict.path, `save refused: ${saveResult.reason}`, now);
      return { ok: false, error: `could not persist resolution (${saveResult.reason}) — the conflict stays`, retryable: true };
    }
    return { ok: true, applied: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Durable retry record: mid-way failure keeps the conflict + records pending op.
    recordRetry(deps, mappingId, conflict.path, message, now);
    return { ok: false, error: `resolution failed: ${message} — original preserved, retry`, retryable: true };
  }
}

/** A stable per-conflict version so stale renders are rejected. Hashes the fields
 *  that matter (path/base/ours/theirs/absent flags) into a compact string. */
function conflictVersionOf(c: FileConflict): string {
  return [
    c.path,
    c.base ?? "<none>",
    c.ours ?? "<absent>",
    c.theirs ?? "<absent>",
    c.oursAbsent ? "d" : "-",
    c.theirsAbsent ? "d" : "-",
  ].join("|");
}

function recordRetry(
  deps: ConflictResolverDeps,
  mappingId: string,
  path: string,
  message: string,
  now: () => number,
): void {
  const op: PendingOperation = {
    opId: `${mappingId}:manual-resolve:vault-write:${path}`,
    kind: "vault-write",
    path,
    state: "failed",
    createdAt: now(),
    attempts: 1,
    lastError: message,
  };
  deps.recordRetry?.(mappingId, op);
}
