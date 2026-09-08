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
  conflicts surface per-file with a user diff view (planned).

## Layout

```
src/
  main.ts         plugin entry point (lifecycle, commands, ribbon)
  store.ts        persistence + credential redaction + blocked-folder validation
  schema.ts       Zod data-plane (single source of truth) + redaction helpers
  settingsTab.ts  settings UI shell
  types.ts        domain interfaces + DEFAULT_SETTINGS
bench/            performance benchmarks (npm run bench)
```

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install deps |
| `npm run dev` | Watch build to `main.js` (unminified) |
| `npm run build` | Type-check + minify production bundle |
| `npm test` | Run unit/contract tests (vitest) |
| `npm run bench` | Run performance benchmarks |

## Installing into Obsidian

1. `npm install && npm run build`
2. Copy `main.js`, `manifest.json`, and `versions.json` into
   `.obsidian/plugins/mugs-obsidian/`.
3. Enable **MUGS — Multi-User Git Sync** in Community plugins (or load via [BRAT](https://github.com/tgrosing/BRAT)
   from the public repo).

## Phases

- **Phase 0 (current):** scaffold, data-plane schema, store with redaction + blocking, test/bench harness.
- **Phase 1:** provider adapters (GitLab-first), credential UI, mapping UI, sync runner.
- **Phase 2:** encryption at rest (WebCrypto AES-GCM), per-user diff view, conflict/rebase UX.
- **Phase 3+:** remaining backends (GitHub/Bitbucket/local), continuous multi-device sync loop testing.

## Security notes

Credentials stored in the vault are only as safe as the vault itself. Enable *Encrypt credentials at
rest* and treat the vault with the same care you would a password manager. The placeholder obfuscation
in `store.ts` is **not** production cryptography — Phase 2 replaces it with AES-GCM + PBKDF2/HKDF.
