# Changelog

Version highlights for each published GitHub release, newest first. Installable assets live on the [Releases page](https://github.com/arikamidotnet/MUGS-obsidian/releases).

## 0.4.27 highlights

- **UI polish from a full settings/views audit.** Non-destructive link buttons
  (Refresh, Copy URI, Update token, Manage, Cancel) now highlight with the
  accent color on hover instead of error red; the single-repo hint under
  **Create token in GitLab ↗** sits on its own line (no stray separator glyph
  when the link wraps); and consecutive account cards in Settings are visually
  separated by a subtle divider.

## 0.4.26 highlights

- **Fix: stretched radio buttons in the GitLab auth-mode and connect-mode toggles.**
  The settings form's width rule set every input to 100% and excluded only
  checkboxes, so the native radio buttons in "Access token / Sign in with
  GitLab" and "Sync specific folders / Sync entire repository" rendered as
  giant oval shapes in several themes. Radios are now excluded from that rule
  and pinned to their native 14px size with the theme accent color.

## 0.4.25 highlights

- **GitLab OAuth 2.0 (PKCE + auto-refresh), additive alongside manual tokens.**
  GitLab accounts can now authenticate via **Sign in with GitLab (OAuth)**
  using Authorization Code + PKCE (no client secret), a temporary `127.0.0.1`
  loopback callback (`http://127.0.0.1:47291/callback`), least-privilege scopes
  (`read_api write_repository read_user`), and a single-flight rotating refresh
  coordinator so concurrent sync passes never race on GitLab's 2-hour tokens.
  OAuth accounts support **Allowed repositories** pinning and one-click
  **Reconnect with GitLab** in place. Manual PATs, fine-grained/project-scoped
  tokens, GitHub, Bitbucket, Gitea, Forgejo, and Local repositories all remain
  unchanged.
- **No more "Secrets are stored without encryption" popup on Linux without a
  keyring.** `secretStore()` now checks Obsidian's `isEncryptionAvailable()`:
  when OS-level encryption is unavailable (common on Arch Linux minimal WMs
  without `gnome-keyring`/`kwallet`), MUGS still reads any pre-existing
  `secretId` but stops writing new secrets into unencrypted `SecretStorage`,
  falling back cleanly to `data.json` (and optional passphrase encryption).
- **Clearer Git auth rejection notices & inline Test & Save token repair.**
  Remote `HTTP Basic: Access denied` / 401 / 403 rejections now report that the
  token was rejected by the remote (expired or missing `read_repository` /
  `write_repository` scope) instead of the generic missing-token message, and
  quiet passes no longer stack two duplicate skip notices. Hosted token accounts
  now include **Test & Save** inline repair and a prefilled **Create token in
  GitLab ↗** link.

## 0.4.24 highlights

- **Universal credential compatibility (Arch Linux / minimal WMs & multi-device).**
  `SecretStorage` writes are now verified with an immediate read-back before
  blanking the durable `token` field, and `secretStore()` rejects hosts with a
  null storage adapter. On Linux systems without a running keyring daemon
  (GNOME Keyring / KWallet / libsecret), tokens fall back cleanly to `data.json`
  (and optional passphrase encryption) instead of disappearing on restart.
  `MugsStore.getCredentialStatus()` surfaces orphaned device-local keychain
  references (`missing-keychain`) honestly, and the Accounts pane now offers
  in-place **Update token** repair so tokens can be re-entered without deleting
  the account or breaking connected folders.
- **Root-sync ("entire repository to vault root") fixes & MUGS state protection.**
  Mappings now record canonical `repoPath` (`owner/repo`) alongside `repoRef`,
  so `resolveRepo` matches reliably across full-access (numeric ID) and
  project-scoped (`Allowed repositories`) tokens. Local repositories can now
  connect to the vault root directly. `.obsidian/plugins/mugs-obsidian/data.json`,
  `.mugs-clones/`, `.git/`, and sync locks are hard-blocked (`isProtectedMugsPath`)
  in both `.obsidian/` scope and `CloneManager.inScope`, so one device's
  credentials or plugin state can never be uploaded or overwrite another user's
  vault during root sync.
- **Simplified onboarding & Settings UX.** Add Account shows Provider + Token
  up front (with self-hosted URL, Label, Username, and Allowed repositories
  under collapsible Advanced options, and bare `/abs/path` normalization for
  local repos). Connected folders offers an explicit **Specific folders** vs.
  **Entire repository to vault root** mode, a custom folder-pair option, and
  inline Account re-binding for orphaned mappings. Explicit actions save and
  trigger sync immediately, passphrase updates no longer collide with drafts,
  and secondary sections collapse by default.

## 0.4.23 highlights

- **Keychain-stored tokens no longer block settings save.** On Obsidian 1.11.4+
  MUGS moves account tokens into the OS keychain (SecretStorage) on first load,
  leaving an empty `token` plus a `secretId` reference in `data.json`. The
  settings draft validator still required a non-empty `token` on every hosted
  credential, so after the first load every keychain credential tripped the
  "token is required" banner — which blocked Apply and left the unsaved-changes
  banner stuck at the top of the pane, so no settings change could be saved.
  The check now accepts `secretId` as satisfying the token requirement, matching
  the Zod schema (which already did). The credential row now shows
  `token: keychain` instead of the misleading `token: not set`.
  - Unchanged: the sync engine, the keychain migration, and the draft/Apply
    model.

## 0.4.22 highlights

- **Settings tab always reflects the live backend.** The settings pane kept a
  draft snapshot of the store; if the tab was opened, closed without applying,
  and the backend changed in the meantime (e.g. a mapping's direction flipped
  by another surface), re-opening showed the stale snapshot. `display()` now
  re-snapshots from the live store on every open unless the user has in-progress
  (dirty) edits, which are preserved. The UI now follows the backend config.
  - Unchanged: the sync engine, the draft/Apply model, and the "never steal a
    live owner" lock contract.

## 0.4.21 highlights

- **Stale clone-lock recovery (liveness fix).** If Obsidian is killed, crashes,
  or is reloaded mid-sync, the clone's advisory lock file was orphaned and
  *every* mapping on that identity stayed `pending` ("clone lock unavailable")
  until a human deleted the lock file from a shell. The lock now auto-reclaims
  when its owner pid is provably gone (`kill(pid,0)` → ESRCH); a live or
  uncertain owner is still never stolen. The clone working tree is MUGS-owned
  scratch re-derived from the vault + remote each pass, and unpushed commits
  are detected and pushed by the sync planner, so reclaiming loses nothing.
  - Unchanged: the sync engine's conflict/deletion guarantees, the Review
    workflow, and the "never steal a live owner" contract (covered by tests).

## 0.4.20 highlights

- **First-run nudge.** A fresh install (no account, no folders yet) now shows a
  one-time notice pointing at Settings → MUGS, so a new user knows where to
  start.
- **Clickable onboarding checklist.** The unfinished Getting Started steps now
  carry a button that jumps straight to the section that completes them
  (Accounts, Connected folders) and expands it.
- **Removed the dead `sameChangeAccept` setting.** The identical-change collapse
  is inherent to the three-way merge and the toggle was never consulted by the
  engine; it is gone from the schema, types and docs. Existing `data.json`
  files that still carry the key load unchanged (the key is simply ignored).
- **Docs:** the getting-started prerequisite now states Obsidian **1.11.4 or
  newer** (required for keychain token storage) instead of 1.8.0.
- **Release workflow:** release notes are now version-agnostic (highlights live
  in this changelog), so the workflow can no longer drift from the docs.
  - Unchanged: the sync engine's conflict/deletion guarantees and the Review
    workflow behave exactly as in 0.4.19.

## 0.4.19 highlights

- **Guided in-app onboarding.** The Getting Started card is now a live three-step
  checklist — account, folders, first sync — that ticks itself off as you
  configure, so a new user sees exactly what is left.
- **Compacted docs.** The release history moved to `CHANGELOG.md`, the README is
  shorter, and `docs/` now has an index.
  - Unchanged: behavior is identical to 0.4.18.

## 0.4.18 highlights

- **Minimum-engagement onboarding.** Settings save automatically (no Apply
  click), a first connection no longer starts paused, the account **Label** is
  filled in from the provider, and the connect-folder form pre-selects a single
  unambiguous folder match. The default check-for-changes interval is now near
  real-time (30 s).
  - Unchanged: the sync engine's conflict/deletion guarantees and the Review
    workflow behave exactly as in 0.4.17.

## 0.4.17 highlights

- **Settings onboarding simplified.** The add-account form fills in each
  provider's API endpoint automatically, checks the base URL / repo paths inline
  as you type, and offers an explicit **Test connection** probe; the
  unsaved-changes banner shows how many changes are pending and lists any problem
  you can click to jump to.
- **A teammate's new file now syncs automatically** instead of landing in the
  Review tab (only deletion races, unreadable/binary, and held paths stay
  reviewable).
- **Account tokens moved to the OS keychain.** On Obsidian 1.11.4+ tokens live in
  the built-in SecretStorage and `data.json` keeps only a reference; existing
  tokens migrate on load. Secrets are device-local, so a second device must
  re-enter them. **Requires Obsidian 1.11.4+.**
- **UI:** the *Changes* view is renamed **Diff**; avatars and a "pushed by"
  attribution appear on the Overview and Diff.
  - Unchanged: the sync engine's conflict/deletion guarantees and the Review
    workflow behave exactly as in 0.4.16.

## 0.4.16 highlights

- **Fix: settings dropdowns now display the saved value.** Every settings
  dropdown set its value *before* adding its options, which Obsidian's
  `DropdownComponent` ignores (no matching option yet) — so the dropdown always
  showed the first option even when a different value was saved. "Start new
  connections with" (first-sync direction) looked like it "didn't toggle when
  saved" even though the value was persisted. Options are now added before the
  value is set, in all seven affected dropdowns (first-sync direction, preferred
  conflict choice, check-for-changes interval, mapping direction, credential
  provider, and the add-mapping form's provider + direction).
  - Unchanged: everything else behaves exactly as in 0.4.15.

## 0.4.15 highlights

- **Fix: a force-reset remote no longer wedges your sync.** If the remote branch
  is force-reset (or rewound) underneath a mapping — e.g. someone runs
  `git push --force` or resets the repo history — the plugin's recorded baseline
  no longer matched the new remote tip, so the merge read every vault file as
  "remote deleted it" and **blocked the whole mapping** (the "changes blocked /
  not syncing" state). Now the pass detects the reset and recovers by
  re-initializing: it re-points the branch at the new tip and re-pushes your
  vault content onto it (additive — remote-only files are kept, nothing is
  deleted). The vault is the source of truth; the reset remote becomes the new
  base. Push-capable mappings only; a pull-only mapping still blocks (it must
  never push).
  - Unchanged: everything else behaves exactly as in 0.4.14.

## 0.4.14 highlights

- **Improvement: genuine conflicts now auto-resolve when the engine is confident.**
  When two people edit the same lines, MUGS previously always asked for a manual
  ours/theirs/both decision. Now, with **Prefer newer edits** on (the default),
  a conflict is auto-resolved to the clearly newer side when the two saves
  clearly differ in time — the winner is committed, pushed and mirrored like any
  clean merge, so all clients converge with no click. When the engine cannot tell
  which side is newer (near-equal or missing timestamps, or the setting off), the
  conflict is still surfaced for an explicit decision — the engine never guesses
  a winner it cannot justify, so the no-silent-data-loss guarantee is preserved.
  - Unchanged: clean (non-overlapping) edits were already auto-merged; everything
    else behaves exactly as in 0.4.13.

## 0.4.13 highlights

- **Improvement: provider errors are now diagnosable.** When a sync pass could
  not reach the provider, the status bar and Overview showed the generic
  "could not reach provider" — the same message for a bad/expired token
  (401/403), a rate limit (429), a server error (5xx), and a plain network
  outage. The real (already-redacted, token-free) provider error is now
  surfaced, and the status report buckets it correctly: 401/403 →
  "check your credentials", 429/5xx → "will retry", network failure →
  "offline". For a company-wide rollout this turns "why is it not syncing?"
  from a guess into a one-line answer.
  - Unchanged: everything else behaves exactly as in 0.4.12.

## 0.4.12 highlights

- **Bug fix: a brand-new empty file is no longer silently dropped from sync.**
  The merge engine's "is there anything to write?" check treated an *absent*
  side (a file that does not exist on that side) the same as an *empty* file,
  so a newly created empty note merged to "equal to the absent side", produced
  no write, and never reached the remote. An absent side is not a current state
  — the file must be created there, so it can never make the pass a no-op.
- **Bug fix: first sync against an empty remote now works.** Pointing a mapping
  at a freshly created empty repository (no commits, no branches — the most
  natural first-time setup) failed with the misleading "branch was not found on
  the remote (deleted or renamed upstream?)" in both push-first and pull-first.
  A remote with no branches is now recognized as empty and the first sync
  pushes to create the branch, whatever the configured first-sync direction
  (including a non-default branch). A non-empty remote whose branch is missing
  still reports the error.
  - Unchanged: everything else behaves exactly as in 0.4.11.

## 0.4.11 highlights

- **Bug fix: a corrupt `data.json` no longer bricks the plugin.** In real
  Obsidian, `loadData()` JSON-parses `data.json` and *throws* on corrupt JSON.
  The store's `load()` only guarded the parse, not the read — so a corrupt file
  (disk failure, partial write, manual edit) made the read reject, the error
  escaped `onload()`, and the plugin loaded with no status bar, no settings and
  no sync. `load()` now guards the read as well: a corrupt file degrades to
  defaults with a sticky "settings could not be read" notice, and the plugin
  refuses to save over the corrupt file until it is fixed or restored.
  - Unchanged: everything else behaves exactly as in 0.4.10.

## 0.4.10 highlights

- **Maintenance & hardening release.** No user-facing behavior change; the
  sync engine, conflict surfacing, Review workflow and scheduling model are
  unchanged from 0.4.9.
  - **Dead code removed.** Unused imports, locals and parameters swept across
    the sync core, providers, store, settings UI and tests; the `draftAuthor`
    helper no longer takes the commit draft it never read (the acting agent
    alone determines the recorded author).
  - **Stricter type-checking.** `noUnusedLocals` and `noUnusedParameters` are
    now enabled in `tsconfig.json`, so the build fails on any future dead
    binding instead of letting it accumulate.
  - **Nix build is DRY.** `flake.nix` reads the version from `package.json`
    (the single source of truth kept in sync by `scripts/check-release.js`)
    instead of a hardcoded value that had drifted to `0.1.0`.
  - **Test portability.** The real-git regression suite shells out via
    `/bin/sh` rather than `/bin/bash`, which is absent on some hosts (e.g.
    NixOS); the commands are plain POSIX git invocations, so behavior is
    identical on GitHub runners.

## 0.4.9 highlights

- **Preflight & staged rollout removed.** The opt-in staged-enablement feature
  (the Preflight page, per-folder canaries before a mapping joined automatic
  sync, rollout records in the sync policy) is gone: every folder syncs
  automatically whenever the vault is not globally paused — one scheduling
  model, no enablement state to manage. The removal follows a real-vault
  incident where a killed session left the vault frozen in staged mode: the
  mode had no exit, a recorded pass failure permanently blocked the canary
  that could clear it, and a shutdown abort was written into durable state as
  a blocked entry. Saved `sync.rollout` state in existing `data.json` files
  is ignored on load and dropped on the next save. The global pause remains
  the maintenance switch; conflict surfacing, the Review workflow and the
  multi-client soak gate are unchanged.

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
  vault-to-repository line comparison using the same diff UI as Conflicts/Diff,
  then confirm explicitly.
  Each batch covers one folder and one sync pass (up to 500 files) instead of one
  sync per file, reporting applied / re-queued / pending outcomes per path.
- Deletion safeguards unchanged: decisions stay revision-bound, recovery backups
  are required before deletion, Download only cannot delete, and filename matches
  never imply identity or permission.
- Review intent that cannot be persisted is rolled back instead of silently
  applying later; sync locks always release; analysis can be cancelled before a decision.
- 0.4.1: consistent Overview/Diff/Review/Conflicts navigation, scoped first
  downloads that survive same-name collisions, deletions that stay deleted, and
  verified idle passes that avoid content reads, rewrites, commits and pushes.

