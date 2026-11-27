# MUGS — Multi-User Git Sync for Obsidian

Desktop-only Git sync with folder mappings, explicit sync directions, recoverable
conflicts, and per-file committed-snapshot comparisons. Fine-grained, folder-mapped
git sync across **all** git backends (GitLab-first), with per-user credentials
stored *inside* the vault and multi-user collaboration built on shared repos +
backend permissions — no hosted backend, no E2E encryption. Requires system Git
and Obsidian 1.11.4 or newer (keychain token storage).

MUGS merges the folder-mapping sync engine model of [Easy-Git](https://github.com/Saiki77/Easy-Git)
with the multi-user concepts of [Sync Deck](https://github.com/ismailivanov/sync-deck), but stays
purely git-native.

Development requires Node 20.19+ (CI pins 20.20.2). Release dependencies are
locked; use `npm ci` for repeatable installs.

## Start here

- [Install MUGS (BRAT or manual), connect your first folder and verify automatic sync](docs/getting-started.md)
- [Set up a GitLab account and project](docs/gitlab.md)
- [Set up a GitHub account and repository](docs/github.md)
- [Roll out to a team safely: steady-state behavior, the review workflow and the Obsidian Sync comparison](docs/rollout.md)

BRAT installs from the [published GitHub release assets](https://github.com/arikamidotnet/MUGS-obsidian/releases)
on this repository. Keep BRAT tracking **Latest** and run **BRAT: Update
plugins** after a new release; a version freeze (optional) silently stops all
update prompts. Back up the vault and plugin state before upgrading or making
a first connection.

## Releases

Highlights for every version live in [CHANGELOG.md](CHANGELOG.md); the
[Releases page](https://github.com/arikamidotnet/MUGS-obsidian/releases) lists
the installable assets.

## Design principles

- **Git-native everywhere.** Sync is plain `git` over the system binary via a hand-rolled thin
  client (no git helper libraries). Backends differ only in how auth + REST metadata are handled;
  GitLab gets first-class v4 API support, and GitHub/Gitea/Forgejo/Bitbucket/local adapters ship today.
- **Fine-grained folder sync.** Each mapping ties a remote path to a vault folder, so different
  users can share one repo while syncing only the folders relevant to them.
- **Tokens live in the OS keychain when it actually works.** On Obsidian 1.11.4+
  the plugin stores account tokens in the built-in SecretStorage — but only
  after a verified write-read round-trip; on Linux systems without a keyring
  daemon (or older builds) tokens fall back to `data.json` with optional
  passphrase encryption instead of being silently dropped. Secrets are
  device-local: a second device re-enters them via **Update token → Test &
  Save** (or **Reconnect** for OAuth) on the existing account, so connected
  folders are never broken. GitLab accounts can also sign in with OAuth 2.0
  (PKCE, least-privilege scopes, auto-refresh).
  Configuration-directory sync is not fully implemented; an opt-in control is not
  a guarantee that `.obsidian/` files are synchronized. Credential-bearing plugin
  data must stay excluded.
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
                      bulk review, settings auto-apply, clone locks, adapter path safety
  membership/         multi-user membership merge (roster + local activity -> summary)
  ui/                 Obsidian views (Overview, Diff, Review, Conflicts)
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
  Overview / Diff / Review / Conflicts navigation on every
  page. (`src/ui/mapView.ts`, `src/ui/navigation.ts`)
- **Diff view** (`mugs-diff`). Select a folder and comparison mode, then
  browse changed files with addition/deletion counts, line numbers, collapsible
  changes, and file-level Git author names where available. Compact cards state
  plainly that only saved Git history is shown.
- **Conflict resolution.** Clean three-way changes auto-merge. A genuine conflict
  (overlapping edits, divergent add/add) is auto-resolved to the clearly newer
  side when the two saves differ in time (recency-wins, on by default); when the
  engine cannot tell which is newer, it is recorded and surfaced in the
  **Conflicts panel** for an explicit ours / theirs / both choice. Writes and
  deletes touching a file open in an editor defer into durable pending
  operations that block proven completion until they are applied and verified.
- **Reconciliation (path-level ownership).** Neither a filename nor an mtime
  proves a vault received a remote file — a matching Git blob does. Every pass
  verifies vault bytes against the published blob IDs from the remote tree.
  A teammate's new file this vault never received is **pulled automatically**
  for a download-permitted mapping; only a file the vault had proven and then
  lost (a deletion or a delete/modify race) lands in the **Review tab**.
  Deletion propagation is per-path: a remote file may be deleted only if its
  path is blob-proven. (`src/sync/reconciliation.ts`, `src/ui/reconciliationReview.ts`)
- **End-to-end sync.** A sync driver (`src/sync/driver.ts`) wires credentials → provider factory → repo → clone manager, driven from the ribbon icon, the *Run sync* command, and a gated scheduler. Manual runs report per-mapping synced / needs-merge / skipped Notices (plus first-sync completion); automatic runs report one aggregate. Recoverable stops — a dirty or unpushed legacy clone, a clone locked by another process — return a *blocked* outcome with a reason and are never auto-reset. (`src/providers/factory.ts`, `src/main.ts`)
- **Settings controls.** Manage credentials and folder mappings; changes
  validate and **save automatically** (a banner lists any problem, each clickable
  to jump to it, and Cancel discards). The add-account form fills in each
  provider's API endpoint **and label** automatically, checks the base URL / repo
  paths inline as you type, and offers an explicit **Test connection** probe. A
  first connection is **not** force-paused — it syncs as soon as it is saved.

Also shipped: first-sync policy, identity-keyed clone sharing with exclusive
cross-process clone locks, event-driven sync (file changes coalesce into a pass
within ~1.5 s; renames count on both the old and new path, so moving a file out
of a mapped folder still propagates the removal; a gated poll — presets
3600 s / 300 s / 30 s, default 30 s, on a 15 s tick — covers remote drift), a
clickable status bar, opt-in passphrase
encryption, serialized settings saves, cancellation on plugin unload, and the
repository-file Review tab (the user surface for reconciliation review rows,
with a file list, preview pane and explicit per-file decisions).
Remaining work (not claiming completeness): binary attachment and full
configuration-directory synchronization, mobile support (desktop-only for now),
vault-content end-to-end encryption, accessible bulk history/restore, per-hunk
blame granularity, agent worktree isolation (pure module exists, unwired) and a
view for the membership data layer. Multi-client behavior is pinned by the
driver-level soak; validating a new release on a scratch vault before company
rollout remains part of the checklist for each team.

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
  published Git blob IDs from the remote tree. A new remote-only path is pulled
  automatically (never auto-deleted); only a proven-then-lost path lands in the
  reconciliation review;
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

- Credentials (provider kind, base URL, username, optional repo allow-list) are stored in the vault's `data.json` via the plugin store. The **token** is stored in Obsidian's SecretStorage (device-local OS keychain, Obsidian 1.11.4+) and `data.json` keeps only a reference; on builds without SecretStorage it falls back to the encrypted/plaintext `data.json` field.
- **Secrets are device-local.** They are not synced with the vault, so a second device must re-enter each account token. Requires Obsidian 1.11.4+ for keychain storage.
- **Encryption at rest is opt-in** (Settings → Security) and uses a passphrase you provide. The passphrase is **never stored** in the vault and cannot be recovered if lost. It applies to the inline `data.json` fallback; keychain-stored tokens need no passphrase.
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
2. In Settings → MUGS → Accounts, add your own token (the API endpoint and label
   are filled in for you; **Test connection** checks it), then in Connected
   folders choose the repository, check the intended matched folders and select
   direction. Press Connect selected folders — settings save automatically and
   sync starts on its own; the banner lists anything to fix first.
3. Background sync then runs without a routine Sync now click; review the mapping
   and the Start new connections with setting when convenient.
   For a staged team rollout, see the [guided rollout checklist](docs/rollout.md).
4. Watch the status bar: `⟳` while syncing (with live phase text), `✓ synced HH:MM`, `⚠ needs merge`,
`✗ sync issues` / `✗ failed`, `⏸ paused`, `👁 hidden`. **Clicking it** opens the Conflicts panel when
something needs a manual merge; the Review tab when repository files need decisions; otherwise the
Overview. The ribbon icon opens the Overview directly.
