# MUGS — Multi-User Git Sync for Obsidian

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
- **Credentials live in the vault**, not the OS keychain. Tokens are never shown in full and can be
  encrypted at rest (`data.json`). Mappings that target `.obsidian/` are rejected outright.
- **Declarative data plane (ADL).** The entire persisted settings object is defined by a single Zod
  schema (`src/schema.ts`) — the single source of truth. TS types are derived from it.
- **jj-inspired conflict/rebase workflow.** Local changes rebase onto the fetched remote history;
  conflicts surface per-file via an attributed diff view, with file-level merge + durable,
  resolvable conflict state (implemented in Phase 5).

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
  sync/               sync driver (syncAllMappings orchestration), clone manager, and contract: classifier, rebase policy, exclusion, (Phase 5) merge/conflict
  membership/         multi-user membership merge (roster + local activity -> summary)
  ui/                 Obsidian views (Map graph, attributed Diff) + pure models + data seams
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

Feature work is delivered in phases (see below). Implemented so far:

- **Folder-mapped sync.** Each mapping ties a remote path to a vault folder; the sync contract classifies last-sync vs local vs remote and decides ff/rebase/none. (`src/sync/`)
- **Fine-grained paths.** gitignore-style include/exclude rules decide which files a mapping touches. (`src/sync/exclusion.ts`)
- **Git-native engine.** A thin `GitClient` over the system `git` binary drives clone/fetch/ff/rebase/push per mapping; clones live under `<vault>/.mugs-clones`. (`src/git/`, `src/sync/cloneManager.ts`)
- **Multi-user visibility.** Merge a backend's member roster with local git activity into a membership summary — access and activity, not enforcement. (`src/membership/`)
- **Map view** (`mugs-map`). A folder->repo graph color-coded by sync status and direction, showing owning users. (`src/ui/mapView.ts`)
- **Diff view** (`mugs-diff`). Compare a mapping against a ref and attribute each changed hunk to its committing author. (`src/ui/diffView.ts`, `src/ui/diffModel.ts`)
- **Conflict resolution.** On divergence, files auto-merge via pure 3-way merge under the Automatic Conflict Resolution policy (auto-merge, tie-break, recency-wins); anything unresolvable surfaces in the dedicated **Conflicts panel** (right sidebar) with Take ours / theirs / both, writing the choice into the clone so the next push carries it. (`src/sync/conflict.ts`, `src/sync/policy.ts`, `src/ui/diffPanel.ts`)
- **End-to-end sync.** A sync driver (`src/sync/driver.ts`) wires credentials → provider factory → repo → clone manager, driven from the ribbon icon and the *Run sync* command; each mapping reports ok / push+pull / conflict / skip as a Notice. (`src/providers/factory.ts`, `src/main.ts`)
- **Settings controls.** Add or delete credentials (provider picker + token) and folder mappings (provider/branch/direction) directly from Settings, with `.obsidian/` targets rejected outright. (`src/settingsTab.ts`)

Also shipped since the phases below: **first-sync direction** (populate the vault from the remote, or upload the vault onto it without downloading history), **shared per-repo blobless clones**, **event-driven sync** on vault changes, a **live clickable status bar** (conflicts → Conflicts panel, otherwise the Diff view), **opt-in token encryption at rest with a passphrase**, and a **live-diagnostic harness** (`MUGS_LIVE_DIAG=1 npx vitest run src/sync/__live_diag.test.ts`) that replays the plugin's exact sync against a real vault/remote. Remaining work: mobile support (desktop-only for now), review-queue producer wiring, per-hunk blame.

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
- **Phase 4:** Map & Diff Obsidian views — folder->repo graph and per-author attributed diff, with store/git-backed data seams; sync driver wired to the ribbon + *Run sync* command; add/delete credentials and mappings in Settings. `✅`
- **Phase 5:** file-level 3-way merge + durable, resolvable conflicts. `✅` Pure three-way auto-merge (`sync/merge.ts`), conflict record model (`sync/conflict.ts`), durable store state (get/set/clearConflicts), merge wired into the sync driver on divergence, and a Diff-view seam to surface + resolve per-file conflicts.
- **Later:** mobile support (desktop-only — the engine uses node:fs + the system git binary), review-queue producer wiring, device-flow auth, per-hunk blame.

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
   vault from the remote; push uploads your vault onto it, additively).
4. Watch the status bar: `⟳` while syncing (with live phase text), `✓ synced HH:MM`, `⚠ needs merge`,
   `✗ sync issues`. **Clicking it** opens the Conflicts panel when something needs a manual merge,
   otherwise the Diff view with the last-sync report.
