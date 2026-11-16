# MUGS — Multi-User Git Sync for Obsidian

Desktop-only Git sync with folder mappings, explicit sync directions, recoverable
conflicts, and per-file committed-snapshot comparisons. Requires system Git and
Obsidian 1.8.0 or newer.

Development requires Node 20.19+ (CI pins 20.20.2). Release dependencies are
locked; use `npm ci` for repeatable installs.

## Start here

- [Install MUGS (BRAT or manual), connect your first folder and verify automatic sync](docs/getting-started.md)
- [Set up a GitLab account and project](docs/gitlab.md)
- [Set up a GitHub account and repository](docs/github.md)
- [Roll out to a team safely: staged enablement, canaries and the Obsidian Sync comparison](docs/rollout.md)

BRAT installs from the [published GitHub release assets](https://github.com/arikamidotnet/MUGS-obsidian/releases),
**not** from this GitLab source repository or an unpublished local candidate.
The latest verified publication when these instructions were written is 0.4.8.
Back up the vault and plugin state before upgrading or making a first connection.

## 0.4.8 highlights

- **Second deep-audit sweep.** A full re-read of the sync core, data plane,
  git layer, providers, runtime and UI, with fixes:
  - **Trash namespace collision.** Mirror-pull vault deletions/overwrites
    recorded their recovery copies under vault-root-relative paths while
    every other recorder used repo-relative keys — two *different* files
    could collide on one `.mugs-trash` key whenever a repo folder shares the
    mapping's local-folder name, and a remote-driven deletion's restore
    could recover an empty copy. All recorders now share the repo-relative
    namespace, pinned by a new real-git e2e test.
  - **Trash key validation.** The filesystem trash store validates mapping
    ids and paths before any disk access (reject, never sanitize):
    recording and clearing throw on unsafe input — an unrecordable deletion
    cannot proceed and the recursive remove never sees an escaped path —
    while reads degrade to empty results.
  - **`unlock()` truly never throws.** Corrupt persisted key-derivation
    parameters (e.g. an invalid salt in `data.json`) resolve to a failed
    unlock instead of throwing out of the settings flow.
  - **Dead code and stale comments removed.** Unused `paginateAllSafe`,
    `redactCredential`, `renderDiffText` and the `autoResolvedPaths` merge
    vestige; a misleading `mirrorPull` parameter name; pre-S06 comments
    claiming genuine conflicts were auto-resolved (they are always
    surfaced for review).
  - **Live-suite hardening.** The real-vault resolution suite's leftover
    cleanup now scans the whole repository (an older suite version could
    strand its probe file at the repo root — outside every mapping's scope,
    where no engine pass could ever remove it), and the real-vault rollout
    gate asserts structural fail-closed invariants instead of a
    point-in-time snapshot of the vault's saved state.

## 0.4.7 highlights (0.4.4–0.4.7)

- **Company-wide release polish.** Documentation and packaging finalized for
  rollout: architecture notes corrected against the shipped code, provider
  walkthroughs updated for the automatic first-connection pause, and package
  metadata (repository, homepage, issues, engines) completed.
- **Deep-audit fixes.** `.drawing` files now really match the
  binary-extension guard (its set entry was capitalized while every lookup
  is case-insensitive, so it never matched), a rename out of a mapped folder
  triggers a pass immediately instead of waiting for the next poll, and the
  plugin and its live diagnostics share one canonical binary-extension set
  (`src/sync/exclusion.ts`). Dead CSS selectors, a dead export and stale
  comments were removed. Otherwise plugin behavior is unchanged from 0.4.6.
- **Preflight & rollout page, restyled to match the Review page.** A folder
  sidebar with live sync-status dots and a search filter sits beside a detail
  pane carrying saved evidence, blockers, rollout state and per-folder
  actions. Every folder row and the detail pane show the last recorded sync
  status (synced / up to date / conflict / failed / pending) with the
  driver-recorded skip reason — saved evidence only, refreshed via pushed UI
  updates instead of polling. (`src/ui/preflightView.ts`,
  `src/runtime/preflight.ts`)
- **Simpler backup acknowledgment.** The single page-level checkbox that
  armed every canary is gone; each folder's detail pane now carries its own
  acknowledgment directly beside the **Run canary** button it arms — one
  decision, one place, per folder.
- **`.aseprite` joined the binary-extension guard**, so Aseprite sprite files
  are excluded from sync scope up front instead of being blocked on every
  pass; blocked-file notices now tell the truth about binary exclusions (they
  never pointed at real review entries). (`src/main.ts`,
  `src/runtime/statusReport.ts`)

## 0.4.3 highlights

- **Staged rollout with guarded canaries.** The new Preflight & rollout page
  switches a vault to staged mode — every folder stops automatic syncing until
  individually enabled — and offers a one-shot canary per folder: a real
  targeted sync pass whose outcome *and durable state* must be verifiably clean
  (no conflicts, deferred changes, pending work or review backlog) and persisted
  before the folder joins automatic sync. Failures fail closed with the reason
  recorded; rollout decisions that cannot be saved pause automatic sync instead
  of running on an unpersisted decision. (`src/ui/preflightView.ts`,
  `src/runtime/rollout.ts`, `src/runtime/preflight.ts`)
- **Multi-client soak evidence.** A new release-gate test runs two full
  independent clients against one shared repository: distinct and
  non-overlapping edits converge automatically on both sides, same-region
  conflicts surface with both sides intact (never silently merged, never lost),
  one-click resolution converges everyone, deletions propagate, and converged
  passes are verified no-ops. (`src/sync/multi-client.e2e.test.ts`)
- **Review analysis sized for real vaults.** Scan budgets rose to 20,000 files,
  8 MiB per file and 512 MiB total so a company vault can complete a scan;
  budget-limited scans still report unmatched results as inconclusive, never as
  proof of absence. (`.apk` also joined the binary-extension guard.)
- Revision-bound recovery and guarded deletion handling prevent stale deferred
  work or remote-delete/local-modify races from silently losing vault content.
- Git subprocess cancellation, exclusive clone ownership and safer adapter path
  handling block concurrent or out-of-scope mutations.
- Status reports surface pending/blocked work; remote-edit reconciliation batches
  immutable blob reads without bypassing startup uncertainty checks.
- The Review tab prioritizes individual preview; optional bulk analysis explains
  its counts, folder scope and the consequences of each action.
- Desktop only. Attachments, settings/plugin sync, mobile and end-to-end vault
  encryption are not supported; MUGS is not an Obsidian Sync replacement claim —
  see [the comparison](docs/rollout.md) for what matches and what differs.

## 0.4.2 highlights

- Bulk repository-file review: on-demand read-only analysis groups review entries
  into exact-content duplicate/move candidates, filename-only candidates, no
  matching vault file and inconclusive scans — with bounded, cancellable scanning.
- Batch decisions with path lists: pick a folder, category and action, inspect
  every repository path/revision and vault candidate, optionally open a lazy
  vault-to-repository line comparison using the same diff UI as Conflicts/Changes,
  then confirm explicitly.
  Each batch covers one folder and one sync pass (up to 500 files) instead of one
  sync per file, reporting applied / re-queued / pending outcomes per path.
- Deletion safeguards unchanged: decisions stay revision-bound, recovery backups
  are required before deletion, Download only cannot delete, and filename matches
  never imply identity or permission.
- Review intent that cannot be persisted is rolled back instead of silently
  applying later; sync locks always release; analysis can be cancelled before a decision.
- 0.4.1: consistent Overview/Changes/Review/Conflicts navigation, scoped first
  downloads that survive same-name collisions, deletions that stay deleted, and
  verified idle passes that avoid content reads, rewrites, commits and pushes.

Use the upgrade/rollback instructions below and retain a private vault backup.

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
  at rest (`data.json`). Configuration-directory sync is not fully implemented;
  an opt-in control is not a guarantee that `.obsidian/` files are synchronized.
  Credential-bearing plugin data must stay excluded.
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
  runtime/            app-runtime transactions: manual conflict resolution, status reporting,
                      staged rollout/canary gating, saved-evidence preflight, bulk review
  membership/         multi-user membership merge (roster + local activity -> summary)
  ui/                 Obsidian views (Overview, Changes, Review, Conflicts, Preflight & rollout)
                      + pure models + data seams
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
- **Overview** (`mugs-map`, the ribbon default). One aligned row per connected
  folder — folder, direction, repository, last sync times and honest status —
  with Sync now, Review files and Settings actions, plus shared
  Overview / Changes / Review / Preflight / Conflicts navigation on every
  page. (`src/ui/mapView.ts`, `src/ui/navigation.ts`)
- **Changes view** (`mugs-diff`). Select a folder and comparison mode, then
  browse changed files with addition/deletion counts, line numbers, collapsible
  changes, and file-level Git author names where available. Compact cards state
  plainly that only saved Git history is shown.
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
  remote-only paths this vault never received land in the **Review tab**
  (never auto-deleted, never blocking the pass from completing), and deletion
  propagation is per-path: a remote file may be deleted only if its path is
  blob-proven. (`src/sync/reconciliation.ts`, `src/ui/reconciliationReview.ts`)
- **End-to-end sync.** A sync driver (`src/sync/driver.ts`) wires credentials → provider factory → repo → clone manager, driven from the ribbon icon, the *Run sync* command, and a gated scheduler. Manual runs report per-mapping synced / needs-merge / skipped Notices (plus first-sync completion); automatic runs report one aggregate. Recoverable stops — a dirty or unpushed legacy clone, a clone locked by another process — return a *blocked* outcome with a reason and are never auto-reset. (`src/providers/factory.ts`, `src/main.ts`)
- **Settings controls.** Manage credentials and folder mappings, with explicit
  Apply/Cancel drafts and validation of protected configuration scopes.

Also shipped: first-sync policy, identity-keyed clone sharing with exclusive
cross-process clone locks, event-driven sync (file changes coalesce into a pass
within ~1.5 s; renames count on both the old and new path, so moving a file out
of a mapped folder still propagates the removal; a gated poll — presets
3600 s / 300 s / 30 s, default 300 s, on a 15 s tick — covers remote drift), a
clickable status bar, opt-in passphrase
encryption, serialized settings saves, cancellation on plugin unload, and the
repository-file Review tab (the user surface for reconciliation review rows,
with a file list, preview pane and explicit per-file decisions).
- **Preflight & staged rollout** (`mugs-preflight`). Review-page layout: a
  folder sidebar with live status dots and a search filter beside a detail
  pane of saved evidence, blockers and rollout state. Staged mode (nothing
  automatic until explicitly enabled), the guarded one-shot canary with its
  per-folder backup acknowledgment co-located beside the button, durable
  enable/disable with fail-closed persistence, and one-click disable.
  (`src/ui/preflightView.ts`, `src/runtime/rollout.ts`)

Remaining work (not claiming completeness): binary attachment and full
configuration-directory synchronization, mobile support (desktop-only for now),
vault-content end-to-end encryption, accessible bulk history/restore, per-hunk
blame granularity, agent worktree isolation (pure module exists, unwired) and a
view for the membership data layer. Multi-client behavior is pinned by the
driver-level soak; per-vault, in-app canary evidence on production mappings
remains part of the rollout checklist for each team.

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
  identity and the mapping's shape (id, local folder, remote path, direction,
  include/exclude globs, trash and `.obsidian/` policy); any change to that
  shape invalidates all proven ownership and
  correspondence — proof is never carried across re-scoped links. After
  first-push and after normal passes, vault bytes are verified against the
  published Git blob IDs from the remote tree. Unknown remote-only paths land
  in the reconciliation review (never auto-deleted, never blocking the pass);
  held, pending, unreadable, or content-mismatch paths are withheld from proof
  (advisory). The "last completed sync" anchor (used by since-sync Diff) only
  advances when every path is verified. A pass that completes with items
  awaiting review reports status *ok* (plan kind *retry-pending*) and carries
  the review list as advisory data — it does not change the outcome status.
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
- Known binary extensions (images, archives, office documents, fonts,
  `.apk`, `.aseprite`, `.drawing`, …) are excluded from sync scope up front —
  matching is case-insensitive and the canonical set lives in
  `src/sync/exclusion.ts`, shared by the plugin and its live diagnostics.
  Any other binary content is excluded from text reconciliation and reported
  as blocked — never merged. Do not assume attachment synchronization is
  supported by the text merge path.

## Credentials and encryption model (current limits)

- Credentials (provider kind, base URL, token, username, optional repo allow-list) are stored in the vault's `data.json` via the plugin store.
- **Encryption at rest is opt-in** (Settings → Security) and uses a passphrase you provide. The passphrase is **never stored** in the vault and cannot be recovered if lost.
- Encryption is **off by default**. Without it, tokens are stored in plaintext inside `data.json`.
- A passphrase-encrypted vault starts every session locked; unlock it in
  Settings → Security. A wrong passphrase leaves credentials in
  a visible "missing token" state — nothing is lost or overwritten. Vaults from
  the older hint-based scheme migrate to the passphrase scheme on first unlock.
  Corrupt saved key-derivation parameters degrade to a failed unlock
  (credentials stay locked) rather than an error.
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

### Bulk repository-file review

Open **Review → Review multiple files (optional) → Analyze review items**.
Analysis is read-only and on demand:
it hashes saved vault text once and groups repository review entries into
exact-content duplicate/move candidates, filename-only candidates, no matching
vault file, or an inconclusive scan. Exact bytes do not prove a move or that the
repository copy is unwanted. Filename matches never prove identity.

Choose a folder, category and action, then **Preview batch**. Inspect every
repository path/revision and the listed vault candidates; use **Compare with…**
to see a bounded, read-only line comparison for a selected pair before checking the
confirmation and applying. Recovery explicitly adds files even in Upload only;
Download only cannot delete repository files. Deletion requires the engine's
recovery backup before removal. Cancel analysis or the preview to leave all
decisions unchanged.

Each batch covers one folder and at most 500 files, saves intent once, and runs
one normal sync pass for that folder (including its other ordinary sync changes).
This avoids one pass per file and prevents another folder's push from staling the
batch revision. Changed, held or open files are not forced through: outcomes show
applied, re-queued and pending counts. Refresh/analyze again after a batch. Batches
are not atomic; saved pending decisions can resume on a later sync. A persistence
failure is reported rather than being presented as success.

The analyzer scans up to 20,000 eligible text files, 8 MiB per file and 512 MiB
total — sized so a real company vault completes a scan. Unreadable, binary or
budget-skipped content is not treated as proof of absence; unmatched results
become inconclusive if the scan was incomplete. Only saved bytes are compared,
not unsaved editor buffers. No batch is applied automatically, and no existing
ownership evidence is upgraded by analysis.

- When a mapping shows "needs merge" / conflict status, open the Conflicts panel (via status bar click or dedicated view) and choose per file: ours / theirs / both.
- When the **Review tab** lists paths (remote files this vault never
  received, or a local deletion that raced a remote edit), open it
  (navigation → *Review*, status-bar click, or command palette → *Review
  repository files*) and decide per file: delete the remote path or recover
  it into the vault. Decisions are bound to the exact ref and blob they were
  made against — if any precondition fails at execution (remote moved, path
  out of scope, file back in the vault or open in an editor), the decision is
  dropped with an advisory and the path re-queues for review; a stale decision
  never executes.
- Resolved choices are written to both the clone's working tree and your vault
  folder, so a stale vault copy cannot resurface the same conflict. The resolved
  record is kept as engine evidence: the next completed pass publishes your
  chosen content (bound to the exact remote bytes it was decided against — a
  remote that moved on re-surfaces the file for a fresh decision) and then
  clears it. Originals are preserved first (`.mugs-origin` sidecar files plus
  the trash store), and a resolution is acknowledged only after the state save
  persists it — a refused save keeps the conflict and records a durable retry.
- Sync-driven deletions are recorded in the trash store
  (`<vault>/.mugs-clones/.mugs-trash`, keyed by mapping id + repo-relative
  path) before removal, so remotely deleted and
  both-sides-deleted content stays recoverable.
- If a clone is in a bad state, pause sync and preserve its index, worktree,
  refs, and untracked files before investigating. Do not delete a clone that
  might contain unpushed work.
- Always keep a backup of the vault and the shared remote before large syncs or conflict resolution.
- Live diagnostics are excluded from routine tests. Never run a second sync
  process against a vault owned by the running plugin: each clone carries an
  exclusive lock file, and the plugin reports a blocked outcome rather than
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

For a published version, follow the [BRAT and manual installation guide](docs/getting-started.md).
Developers may run `npm ci && npm run build` in a separate source checkout and
copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/mugs-obsidian/`; this does not publish a release.

## Phases

- **Phase 0:** scaffold, data-plane schema, store with redaction + blocking, Nix flake, test/bench harness. `✅`
- **Phase 1:** provider contract + GitLab v4 adapter (auth + discovery). `✅`
- **Phase 2a:** sync-contract logic — 3-way classifier, rebase/pull policy, gitignore-style exclusion, commit messages. `✅`
- **Phase 2b:** thin git client wrapper + per-mapping clone manager (fetch/ff/rebase/push driver). `✅`
- **Phase 3:** multi-user membership view data layer (roster + local activity -> summary), visibility only. `✅`
- **Phase 4:** Map & Diff Obsidian views — folder->repo graph and Diff with baseline comparison, with store/git-backed data seams; sync driver wired to the ribbon + *Run sync* command; add/delete credentials and mappings in Settings. `✅`
- **Phase 5:** file-level 3-way merge + durable, resolvable conflicts. `✅`
- **Later:** mobile support (desktop-only — the engine uses node:fs + the system git binary), device-flow auth, per-hunk blame, agent worktree isolation, a membership view.

## Security notes

Credentials are stored in the vault's `data.json`. When you enable **Encrypt saved tokens**
(Settings → Security), tokens are encrypted at rest with a passphrase you choose; the
passphrase is never stored in the vault and cannot be recovered. Encryption is **off by default** —
without it tokens are stored as-is, so treat the vault with the same care you would a password
manager. Git authentication passes tokens through per-invocation environment variables (never argv,
`.git/config`, or logs); tokens are masked wherever displayed; provider error messages contain URLs,
never credentials.

## Teammate quickstart

1. [Install and start safely](docs/getting-started.md), using the [GitLab](docs/gitlab.md)
   or [GitHub](docs/github.md) token walkthrough. **Desktop Obsidian only.**
2. In Settings → MUGS → Accounts, add your own token, then in Connected folders
   choose the repository, check the intended matched folders and select direction.
   Press Connect selected folders and **Apply settings**. A *first* mapping
   starts paused automatically; unpause only after reviewing the connection.
3. Review the mapping, backup and Start new connections with setting; unpause and
   Apply only when safe. Background sync then runs without a routine Sync now click.
   Teams preferring per-folder enablement can use the
   [Preflight & staged rollout](docs/rollout.md) flow instead of a global unpause.
4. Watch the status bar: `⟳` while syncing (with live phase text), `✓ synced HH:MM`, `⚠ needs merge`,
`✗ sync issues` / `✗ failed`, `⏸ paused`, `👁 hidden`. **Clicking it** opens the Conflicts panel when
something needs a manual merge; the Review tab when repository files need decisions; otherwise the
Overview. The ribbon icon opens the Overview directly.
