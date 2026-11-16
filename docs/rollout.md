# Guided rollout and staged enablement

How to take a MUGS connection from *paused and unproven* to *automatic like
Obsidian Sync* — without betting shared company content on an unverified
mapping. Read [getting started](getting-started.md) first; this page assumes
mappings exist and covers the enablement workflow.

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
- Genuine conflicts get a one-click **ours / theirs / both** decision in the
  Conflicts panel; the engine never picks a winner silently.

Four cases are deliberately **not** automatic, because automatic action there
can lose or duplicate shared content:

| Case | What MUGS does | Why not automatic |
| --- | --- | --- |
| Same-region edits to one file | Surfaces the conflict with both sides intact | Only a human can know which edit is wanted; silent picks lose bytes |
| Repository files this vault never received | Review tab: copy into the vault or delete from the repository | Cannot distinguish a teammate's new file from your own unpropagated deletion |
| Deleting shared repository files | Explicit confirmation, recovery backup first | Affects every other user; a name match is not consent |
| Joining automatic sync (staged mode) | One clean canary pass per folder | One-time proof the folder syncs safely before it runs unattended |

The first three are rare in steady state; most appear once, when a mapping is
first connected over repositories that already contain history.

## Preflight & rollout page

Open it from any MUGS page's navigation (**Preflight**) or the command palette
(**MUGS: Open preflight and rollout**). The page uses the same layout as the
Review tab: a folder sidebar — each row carrying a live sync-status dot and a
search filter — beside a detail pane for the selected folder. It shows, per
folder:

- saved local evidence only: last recorded sync status and skip reason,
  review / conflict / pending counts, last sync timestamp, recorded clone —
  no remote access happens by just opening it;
- blockers that must be resolved before a folder can be enabled (unproven
  clone, no baseline, review backlog, unresolved conflicts, pending work, held
  changes, prior rollout failures).

**Start staged rollout** switches the vault from legacy scheduling (all
mappings automatic when unpaused) to staged mode: *every* folder stops
automatic syncing until individually enabled. The global pause still takes
precedence over everything.

## The one-shot canary

For each blocker-free folder, the folder's detail pane offers **Run canary
and enable automatic sync**, gated by a per-folder backup acknowledgment
sitting directly beside the button — check it and the canary arms; no other
control stands between you and the pass. A canary:

1. re-checks saved state (any blocker aborts before syncing);
2. runs one real targeted sync pass for that folder only — this is the live
   evidence: it reaches the remote, revalidates the clone, merges and pushes;
3. evaluates the outcome and the durable state, never just "the pass didn't
   throw": deferred changes, blocked files, pending operations, review
   entries, unresolved conflicts or an unsaved state each fail the canary;
4. enables the folder for automatic sync only if the pass is verifiably clean
   **and** the result persisted.

Any failure leaves the folder disabled with the reason recorded on the page —
a failed canary is retryable once the underlying problem is fixed. Disabling a
folder is always one click and never requires a canary. A rollout decision
that cannot be saved fails closed: automatic sync is paused rather than left
running on an unpersisted decision.

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
   `data.json`) and `.mugs-clones/` — and keep the backup until step 6.
2. Install a **frozen published release** via BRAT (see
   [getting started](getting-started.md)); verify the version in Settings.
3. Open **Preflight** and **Start staged rollout**. Nothing syncs
   automatically now, even unpaused.
4. **Clear the Review backlog** folder by folder, and **canary each folder**
   once its blockers are gone. Only canary-passed folders join automatic sync.
5. Soak: with a second device or scratch vault, confirm the steady-state
   behaviors above hold for your team's edit patterns.
6. When every folder you intend to automate has a clean canary, leave staged
   mode on (recommended) or return to legacy scheduling; unpause globally.
7. Rollback: restore the previous plugin assets **and compatible state**; see
   the upgrade/rollback notes in the README. Never force-push as recovery.

## How this compares with Obsidian Sync

| | MUGS | Obsidian Sync |
| --- | --- | --- |
| Transport | Plain Git over HTTPS (your GitLab/GitHub repos) | Proprietary hosted service |
| Cost | Your git host + tokens | Subscription |
| Steady-state automation | Same: edits sync in the background without clicks | Same |
| Clean concurrent edits | Three-way merge, all clients converge | Merged |
| Conflicting edits | One explicit decision, both sides preserved | "Conflict copy" duplicates |
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
