# Guided rollout for a team

How to take a MUGS connection from *paused and unproven* to *automatic like
Obsidian Sync* — without betting shared company content on an unverified
mapping. Read [getting started](getting-started.md) first; this page assumes
mappings exist and covers the rollout workflow.

## The model: automatic by default, gated where bytes are at stake

In steady state MUGS behaves like a live sync service. Every behavior below is
pinned by the two-client soak (`src/sync/multi-client.e2e.test.ts`), which runs
two full independent clients against one shared repository:

- A local edit triggers a background pass within seconds (events coalesce
  ~1.5 s; a burst waits at most 20 s).
- Remote edits arrive on the periodic drift check (default 300 s, presets down
  to 30 s) and on catch-up when the window regains focus or the network returns.
- Edits in different files — or non-overlapping parts of the same file — merge
  automatically (three-way), on every client, with no clicks.
- New remote files download automatically; deletions propagate; identical
  changes on both sides collapse (the same-change rule).
- A fully converged pass is a verified no-op: no reads, commits or pushes.
- A genuine conflict is auto-resolved to the clearly newer side when the two
  saves differ in time (recency-wins, on by default); when the engine cannot
  tell which is newer, it gets a one-click **ours / theirs / both** decision in
  the Conflicts panel. The engine never guesses a winner it cannot justify.

Three cases are deliberately **not** automatic, because automatic action there
can lose or duplicate shared content:

| Case | What MUGS does | Why not automatic |
| --- | --- | --- |
| Same-region edits where the engine can't tell which is newer (near-equal or missing timestamps) | Surfaces the conflict with both sides intact | Only a human can know which edit is wanted when recency gives no clear winner; a guessed pick loses bytes |
| Repository files this vault never received | Review tab: copy into the vault or delete from the repository | Cannot distinguish a teammate's new file from your own unpropagated deletion |
| Deleting shared repository files | Explicit confirmation, recovery backup first | Affects every other user; a name match is not consent |

The first two are rare in steady state; most appear once, when a mapping is
first connected over repositories that already contain history.

## First-connection safety

A mapping created with a new plugin candidate starts **paused** after Apply
(the settings banner explains this). While paused nothing syncs automatically —
inspect the connected-folder card, verify the route and direction, and decide
the first-sync direction (**Download from repository** or **Upload from this
device**; see getting started). When you are satisfied, turn
**Pause automatic sync** off and Apply: the next tick (≤15 s) starts syncing.

The global pause remains the maintenance switch for the whole vault: bulk
edits, upgrades and investigations happen with automatic sync paused, and a
manual **Sync now** remains available even while paused.

## Review backlog (existing repositories)

When a mapping is first connected over a repository that already has files,
paths this vault never received queue in the **Review** tab. Decide them
folder by folder with **Review multiple files**: analyze (read-only) groups
entries into exact-content, filename-only, no-match and inconclusive
categories; a batch of up to 500 applies one action with explicit
confirmation. Recovery copies content into the vault; deletion removes it for
everyone after a recovery backup. Nothing is auto-approved.

The analyzer scans up to 20,000 files, 8 MiB per file and 512 MiB total —
sized so a real company vault completes a scan. If a scan still hits the
budget, unmatched results are reported as inconclusive, never as "no match".

## Company rollout checklist

1. **Back up** the vault, `.obsidian/plugins/mugs-obsidian/` (including
   `data.json`) and `.mugs-clones/` — and keep the backup until step 5.
2. Install a **frozen published release** via BRAT (see
   [getting started](getting-started.md)); verify the version in Settings.
3. **Connect folders one at a time, paused**: clear each folder's Review
   backlog, then run one manual **Sync now** and confirm a clean outcome on
   the Overview before moving to the next.
4. Soak: with a second device or a scratch vault, confirm the steady-state
   behaviors above hold for your team's edit patterns.
5. When every folder you intend to automate is clean, **unpause globally** —
   from here the vault syncs automatically.
6. Rollback: restore the previous plugin assets **and compatible state**; see
   the upgrade/rollback notes in the README. Never force-push as recovery.

## How this compares with Obsidian Sync

| | MUGS | Obsidian Sync |
| --- | --- | --- |
| Transport | Plain Git over HTTPS (your GitLab/GitHub repos) | Proprietary hosted service |
| Cost | Your git host + tokens | Subscription |
| Steady-state automation | Same: edits sync in the background without clicks | Same |
| Clean concurrent edits | Three-way merge, all clients converge | Merged |
| Conflicting edits | Auto-resolved to the clearly newer side; otherwise one explicit decision, both sides preserved | "Conflict copy" duplicates |
| Unknown/ambiguous files | One explicit decision | Downloaded |
| Deletions | Propagate, recoverable via trash store | Propagate, version history |
| Content encryption | Token encryption at rest only; repository holds plaintext | End-to-end encrypted |
| Attachments / binaries | Excluded (text sync only) | Synced |
| Mobile | Desktop only | Supported |
| Settings sync | Not release-ready | Supported |
| History | Full git history, any git tooling | Version history in-app |

**Verdict:** in steady state MUGS is as automatic as Obsidian Sync for text
notes — the soak test pins that. The difference is deliberate: where Obsidian
Sync's server can decide silently (or duplicate), MUGS asks once, because a
git client cannot recover content a silent decision destroyed. Expect a
one-time decision cost when connecting over existing repositories, and rare
one-click decisions afterwards.
