# MUGS — Multi-User Git Sync for Obsidian

Fine-grained, folder-mapped git sync across **all** git backends (GitLab-first),
with per-user credentials stored *inside* the vault and multi-user collaboration
built on shared repos + backend permissions — no hosted backend, no E2E encryption.

MUGS merges the folder-mapping sync engine model of [Easy-Git](https://github.com/Saiki77/Easy-Git)
with the multi-user concepts of [Sync Deck](https://github.com/ismailivanov/sync-deck), but stays
purely git-native.

## Design principles

- **Git-native everywhere.** Sync is plain `git` (via `simple-git`). Backends differ only in how
  auth + REST metadata are handled; GitLab gets first-class v4 API support.
- **Fine-grained folder sync.** Each mapping ties a remote path to a vault folder, so different
  users can share one repo while syncing only the folders relevant to them.
- **Credentials live in the vault**, not the OS keychain. Tokens are never shown in full and can be
  encrypted at rest (`data.json`). Mappings that target `.obsidian/` are rejected outright.
- **Declarative data plane (ADL).** The entire persisted settings object is defined by a single Zod
  schema (`src/schema.ts`) — the single source of truth. TS types are derived from it.
- **jj-inspired conflict/rebase workflow.** Local changes rebase onto the fetched remote history;
  conflicts surface per-file via an attributed diff view, with file-level merge + durable,
  resolvable conflict state landing in Phase 5.

## Layout

```
src/
  main.ts             plugin entry point (lifecycle, commands, ribbon, view registration)
  store.ts            persistence + credential redaction + blocked-folder validation
  schema.ts           Zod data-plane (single source of truth) + redaction helpers
  types.ts            domain interfaces + DEFAULT_SETTINGS
  settingsTab.ts      settings UI shell
  git/                thin git client over the system `git` binary + child-process runner
  providers/          backend adapters: contract, GitLab v4, HTTP transport, schema
  sync/               sync contract: classifier, rebase policy, exclusion, (Phase 5) merge/conflict
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

Coming next: file-level 3-way merge with durable, resolvable conflicts (Phase 5), then additional backends and real encryption at rest.

## Installing into Obsidian

1. `npm install && npm run build`
2. Copy `main.js`, `manifest.json`, and `versions.json` into
   `.obsidian/plugins/mugs-obsidian/`.
3. Enable **MUGS — Multi-User Git Sync** in Community plugins (or load via [BRAT](https://github.com/tgrosing/BRAT)
   from the public repo).

## Phases

- **Phase 0:** scaffold, data-plane schema, store with redaction + blocking, Nix flake, test/bench harness. `✅`
- **Phase 1:** provider contract + GitLab v4 adapter (auth + discovery). `✅`
- **Phase 2a:** sync-contract logic — 3-way classifier, rebase/pull policy, gitignore-style exclusion, commit messages. `✅`
- **Phase 2b:** thin git client wrapper + per-mapping clone manager (fetch/ff/rebase/push driver). `✅`
- **Phase 3:** multi-user membership view data layer (roster + local activity -> summary), visibility only. `✅`
- **Phase 4 (current):** Map & Diff Obsidian views — folder->repo graph and per-author attributed diff, with store/git-backed data seams. `🚧`
- **Phase 5:** file-level 3-way merge + durable, resolvable conflicts. Planned.
- **Later:** remaining backends (GitHub/Forgejo/Gitea/Bitbucket/local), real encryption at rest (AES-GCM), device-flow auth, multi-device sync loop testing.

## Security notes

Credentials stored in the vault are only as safe as the vault itself. Enable *Encrypt credentials at
rest* and treat the vault with the same care you would a password manager. The placeholder obfuscation
in `store.ts` is **not** production cryptography — Phase 2 replaces it with AES-GCM + PBKDF2/HKDF.
