# MUGS — Multi-User Git Sync for Obsidian

Desktop-only Git sync with folder mappings, explicit sync directions, recoverable
conflicts, and per-file committed-snapshot comparisons. Requires system Git and
Obsidian 1.8.0 or newer.

Development requires Node 20.19+ (CI pins 20.20.2). Release dependencies are
locked; use `npm ci` for repeatable installs.

Fine-grained, folder-mapped git sync across **all** git backends (GitLab-first),
with per-user credentials stored *inside* the vault and multi-user collaboration
built on shared repos + backend permissions — no hosted backend, no E2E encryption.

MUGS merges the folder-mapping sync engine model of [Easy-Git](https://github.com/Saiki77/Easy-Git)
with the multi-user concepts of [Sync Deck](https://github.com/ismailivanov/sync-deck), but stays
purely git-native.

## Design principles

- **Git-native everywhere.** Sync is plain `git` over the system binary via a hand-rolled thin
  client (no git helper libraries). Backends differ only in how auth + REST metadata are handled;
  GitLab gets first-class v4 API support, and GitHub/Gitea/Forgejo/Bitbucket/local adapters ship today.
- **Fine-grained folder sync.** Each mapping ties a remote path to a vault folder, so different
  users can share one repo while syncing only the folders relevant to them.
- **Credentials live in the vault**, not the OS keychain. Tokens can be encrypted
  at rest (`data.json`). `.obsidian/` syncing requires explicit opt-in and scope
  policy; credential-bearing plugin data must stay excluded.
- **Declarative data plane (ADL).** The entire persisted settings object is defined by a single Zod
  schema (`src/schema.ts`) — the single source of truth. TS types are derived from it.
- **Recoverable conflicts.** Clean three-way changes merge automatically; genuinely
  conflicting files remain visible for explicit resolution rather than silently
  choosing a timestamp winner or concatenating structured documents.

## Layout

```
src/
  main.ts             plugin entry point (lifecycle, commands, ribbon, view registration)
  store.ts            persistence + credential redaction + blocked-folder validation
  schema.ts           Zod data-plane (single source of truth) + redaction helpers
  types.ts            domain interfaces + DEFAULT_SETTINGS
  settingsTab.ts      settings UI: add/delete credentials + folder mappings
  git/                thin git client over the system `git` binary + child-process runner
  providers/          backend adapters: contract, GitLab v4, HTTP transport, schema + provider factory
  sync/               sync driver (syncAllMappings orchestration), clone manager (identity-keyed shared clones), and the merge contract: classifier, rebase policy, exclusion, merge/conflict, reconciliation (path-level ownership proof)
  runtime/            app-runtime transactions: manual conflict resolution, aggregate status reporting
  membership/         multi-user membership merge (roster + local activity -> summary)
  ui/                 Obsidian views (Map graph, Diff) + pure models + data seams
bench/              performance benchmarks (npm run bench)
```

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install deps |
| `npm run dev` | Watch build to `main.js` (unminified) |
| `npm run build` | Type-check + minify production bundle |
| `npm test` | Run unit/contract tests (vitest) |
| `npm run bench` | Run performance benchmarks |

## Features & status

Implemented features:
- **Folder-mapped sync.** Each mapping ties a remote path to a vault folder; the sync contract classifies last-sync vs local vs remote and decides ff/rebase/none. (`src/sync/`)
- **Fine-grained paths.** gitignore-style include/exclude rules decide which files a mapping touches. (`src/sync/exclusion.ts`)
- **Git-native engine.** A thin `GitClient` over the system `git` binary drives clone/fetch/stage/commit/push per mapping — no `git pull` or `git rebase` runs; divergence is merged file-by-file into the clone's working tree and committed on the remote tip. Clones live under `<vault>/.mugs-clones`, keyed by resolved repository identity (provider, repo, branch, normalized remote) and shared by every mapping pointing at that identity. (`src/git/`, `src/sync/cloneManager.ts`, `src/sync/repoIdentity.ts`)
- **Multi-user visibility.** A pure data layer merges a backend's member roster with local git activity into a membership summary — access and activity, not enforcement. No view surfaces it yet. (`src/membership/`)
- **Map view** (`mugs-map`). A folder->repo graph color-coded by sync status and direction, showing owning users. (`src/ui/mapView.ts`)
- **Per-file Diff view** (`mugs-diff`). Select a mapping and comparison mode, then
  browse changed files with addition/deletion counts, line numbers, collapsible
  changes, and file-level Git author names where available.
- **Conflict resolution.** Clean three-way changes auto-merge; genuine conflicts
  (overlapping edits, divergent add/add) are recorded and surfaced in the
  **Conflicts panel** for an explicit ours / theirs / both choice — the
  recency and tie-break settings are one-click suggestions in the panel,
  never applied silently. Writes and deletes touching a file open in an editor
  defer into durable pending operations that block proven completion until
  they are applied and verified.
- **Reconciliation (path-level ownership).** Neither a filename nor an mtime
  proves a vault received a remote file — a matching Git blob does. Every pass
  verifies vault bytes against the published blob IDs from the remote tree;
  remote-only paths this vault never received land in a **Reconciliation review**
  (never auto-deleted, never blocking the pass from completing), and deletion
  propagation is per-path: a remote file may be deleted only if its path is
  blob-proven. (`src/sync/reconciliation.ts`, `src/ui/reconciliationModal.ts`)
- **End-to-end sync.** A sync driver (`src/sync/driver.ts`) wires credentials → provider factory → repo → clone manager, driven from the ribbon icon, the *Run sync* command, and a gated scheduler. Manual runs report per-mapping synced / needs-merge / skipped Notices (plus first-sync completion); automatic runs report one aggregate. Recoverable stops — a dirty or unpushed legacy clone, a clone locked by another process — return a *blocked* outcome with a reason and are never auto-reset. (`src/providers/factory.ts`, `src/main.ts`)
- **Settings controls.** Manage credentials and folder mappings, with explicit
  Apply/Cancel drafts and validation of protected configuration scopes.

Also shipped: first-sync policy, identity-keyed clone sharing with advisory
cross-process clone locks, event-driven sync (file changes coalesce into a pass
within ~1.5 s; a gated poll — presets 3600 s / 300 s / 30 s, default 300 s, on a
15 s tick — covers remote drift), a clickable status bar, opt-in passphrase
encryption, serialized settings saves, cancellation on plugin unload, and the
reconciliation review modal (the user surface for reconciliation review rows,
with explicit per-file decisions).

Remaining work (not claiming completeness): mobile support (desktop-only for
now); per-hunk blame granularity; surfacing blocked and deferred outcomes in
the status-bar aggregate (manual runs announce review items and the
reconciliation modal surfaces them, but automatic runs and the status-bar
report still ignore blocked/deferred counts); agent worktree isolation (pure
module exists, unwired); a view for the membership data layer.

## Sync flow and directions (current behavior)

- Mapping direction applies to every pass: **push-only** never applies remote
  content to the vault; **pull-only** never publishes local content; **push/pull**
  reconciles both sides.
- First-sync policy controls initialization within those direction permissions.
  Back up existing content and review the mapping before its first run.
- Discovery and planning precede execution. Proven idle passes avoid unnecessary
  reconciliation; startup and uncertain change evidence require verification.
- Fetched remote tips, clone HEAD, proven correspondence, and pending operations
  are separate state. Deferred editor writes must not count as completed sync:
  they persist as pending operations that block proven correspondence from
  advancing and are re-verified against actual vault bytes on the next pass.
  Per-file blocked outcomes (binary, unreadable, unsafe paths) carry redacted
  reasons and are never treated as deletions.
- **Reconciliation proof.** Every pass computes a fingerprint over the repo
  identity and the mapping's shape (local folder, remote path, direction,
  filters); any change to that shape invalidates all proven ownership and
  correspondence — proof is never carried across re-scoped links. After
  first-push and after normal passes, vault bytes are verified against the
  published Git blob IDs from the remote tree. Unknown remote-only paths land
  in the reconciliation review (never auto-deleted, never blocking the pass);
  held, pending, unreadable, or content-mismatch paths are withheld from proof
  (advisory). The "last completed sync" anchor (used by since-sync Diff) only
  advances when every path is verified. A pass that completes with items
  awaiting review reports status *ok* and carries the review list as advisory
  data — it does not change the outcome status.
- Generated commits receive explicit author and committer identities from the
  configured provider/agent where available, with a deterministic fallback.
  A teammate's global Git configuration is not required.
- Dirty or unpushed legacy clones block migration for review; they are not reset.
- **Deletion propagation is per-path.** A remote file may be deleted only if
  its path is proven (blob-verified); unproven paths are retained on the
  remote. An additive first push never grants global deletion permission.
  A proven local deletion that races a remote edit (the remote blob changed
  after the local delete's base) is not pushed — it becomes a review entry
  and the remote content is preserved.
- Legacy mappings without proven population retain remote paths missing locally.
  A rename can therefore publish the new name while retaining the old remote name.
  Do not force the population flag to enable deletion: first reconcile the mapping
  against a backup and prove which paths the vault has actually received.
- Startup verification can take several minutes on large mappings. Subsequent
  passes can reuse unchanged scoped trees, including when another mapping advances
  the shared repository tip.
- Binary content is excluded from text reconciliation and reported as blocked.
  Do not assume attachment synchronization is supported by the text merge path.

## Credentials and encryption model (current limits)

- Credentials (provider kind, base URL, token, username, optional repo allow-list) are stored in the vault's `data.json` via the plugin store.
- **Encryption at rest is opt-in** (Settings → Security & Credentials) and uses a passphrase you provide. The passphrase is **never stored** in the vault and cannot be recovered if lost.
- Encryption is **off by default**. Without it, tokens are stored in plaintext inside `data.json`.
- A passphrase-encrypted vault starts every session locked; unlock it in
  Settings → Security & Credentials. A wrong passphrase leaves credentials in
  a visible "missing token" state — nothing is lost or overwritten. Vaults from
  the older hint-based scheme migrate to the passphrase scheme on first unlock.
- Treat an unencrypted vault with the same care as a password manager.
- At runtime, tokens are passed to git/provider calls via per-invocation environment variables only (never written to argv, `.git/config`, or persistent logs).
- Tokens are redacted in UI and masked in most error paths. Provider errors may still surface URLs.

## Diff semantics (current)

- **Since completed sync:** compare proven correspondence with committed HEAD.
  Without proven correspondence, choose a history comparison or complete a sync.
- **Previous commit:** compare the previous committed snapshot with HEAD.
- **Custom older ref:** compare the selected older committed snapshot with HEAD.
- Select a changed file to inspect its changes. Queries stay within the mapping's
  repository subtree.
- **Unsynced vault edits are not included.** Identical committed snapshots do not
  prove the live vault has no pending edits.
- Author names are file-level Git history evidence, not per-line blame, verified
  human identities, or the identity of someone currently editing a note.
- Conflicts (if any) are rendered above the diff and can be resolved from the panel.

## Operator recovery notes (current)

- When a mapping shows "needs merge" / conflict status, open the Conflicts panel (via status bar click or dedicated view) and choose per file: ours / theirs / both.
- When the **Reconciliation review** lists paths (remote files this vault never
  received, or a local deletion that raced a remote edit), open the
  Reconciliation review modal and decide per file: delete the remote path or
  recover it into the vault. Decisions are bound to the exact blob they were
  made against — a changed remote blob re-queues the path for review instead
  of executing a stale decision.
- Resolved choices are written to both the clone's working tree and your vault
  folder, so a stale vault copy cannot resurface the same conflict. Originals
  are preserved first (`.mugs-origin` sidecar files plus the trash store), and
  a resolution is acknowledged only after the state save persists it — a
  refused save keeps the conflict and records a durable retry.
- Sync-driven deletions are recorded in the trash store
  (`<vault>/.mugs-clones/.mugs-trash`) before removal, so remotely deleted and
  both-sides-deleted content stays recoverable.
- If a clone is in a bad state, pause sync and preserve its index, worktree,
  refs, and untracked files before investigating. Do not delete a clone that
  might contain unpushed work.
- Always keep a backup of the vault and the shared remote before large syncs or conflict resolution.
- Live diagnostics are excluded from routine tests. Never run a second sync
  process against a vault owned by the running plugin: each clone carries an
  advisory lock file, and the plugin reports a blocked outcome rather than
  compete with another process.

### Upgrade and rollback

Pause sync and back up the vault, `.obsidian/plugins/mugs-obsidian/` (including
private `data.json`), and `.mugs-clones` before upgrading. Install the three release
assets, reload the plugin, and verify mapping outcomes before resuming work.
Keep backup permissions private: plugin state may contain credentials.

Rollback requires the matching previous plugin assets **and compatible saved
settings/state**. Preserve legitimate newer edits and pending work rather than
blindly restoring an old vault tree. Never force-push as an automatic recovery.

## Installing into Obsidian

1. `npm install && npm run build`
2. Copy `main.js`, `manifest.json`, and `styles.css` into
`.obsidian/plugins/mugs-obsidian/`.
3. Enable **MUGS — Multi-User Git Sync** in Community plugins (or install via [BRAT](https://github.com/TfTHacker/obsidian42-brat)
from the public repo).

## Phases

- **Phase 0:** scaffold, data-plane schema, store with redaction + blocking, Nix flake, test/bench harness. `✅`
- **Phase 1:** provider contract + GitLab v4 adapter (auth + discovery). `✅`
- **Phase 2a:** sync-contract logic — 3-way classifier, rebase/pull policy, gitignore-style exclusion, commit messages. `✅`
- **Phase 2b:** thin git client wrapper + per-mapping clone manager (fetch/ff/rebase/push driver). `✅`
- **Phase 3:** multi-user membership view data layer (roster + local activity -> summary), visibility only. `✅`
- **Phase 4:** Map & Diff Obsidian views — folder->repo graph and Diff with baseline comparison, with store/git-backed data seams; sync driver wired to the ribbon + *Run sync* command; add/delete credentials and mappings in Settings. `✅`
- **Phase 5:** file-level 3-way merge + durable, resolvable conflicts. `✅`
- **Later:** mobile support (desktop-only — the engine uses node:fs + the system git binary), device-flow auth, per-hunk blame, surfacing blocked/deferred outcomes in the status bar and Notices, agent worktree isolation, a membership view.

## Security notes

Credentials are stored in the vault's `data.json`. When you enable **Encrypt credentials at rest**
(Settings → Security & Credentials), tokens are encrypted at rest with a passphrase you choose; the
passphrase is never stored in the vault and cannot be recovered. Encryption is **off by default** —
without it tokens are stored as-is, so treat the vault with the same care you would a password
manager. Git authentication passes tokens through per-invocation environment variables (never argv,
`.git/config`, or logs); tokens are masked wherever displayed; provider error messages contain URLs,
never credentials.

## Teammate quickstart

1. Install: copy `main.js`, `manifest.json`, `styles.css` into `.obsidian/plugins/mugs-obsidian/`
(or add the repo via [BRAT](https://github.com/TfTHacker/obsidian42-brat)). **Desktop Obsidian only.**
2. Settings → MUGS → Credentials: add your GitLab PAT (needs `api` scope + access to the shared repo),
your username, and optionally restrict the token to that repo.
3. Folder Mappings: pick your credential → the shared repo → check your folders → choose direction.
Agree with your team on the **first-sync direction** before the first run (pull populates your
vault from the remote by default; push uploads the vault onto it, additively).
4. Watch the status bar: `⟳` while syncing (with live phase text), `✓ synced HH:MM`, `⚠ needs merge`,
`✗ sync issues` / `✗ failed`, `⏸ paused`, `👁 hidden`. **Clicking it** opens the Conflicts panel when
something needs a manual merge; otherwise opens the Diff view (baseline comparison).
