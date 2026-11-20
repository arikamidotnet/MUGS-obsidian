# Install and start MUGS

MUGS synchronizes eligible **text files** between a desktop Obsidian vault and
Git over HTTPS. The quickest path is: install a published release, back up your
vault, add a Git account, connect matching folders, inspect the mapping, then
resume automatic sync. Once configured, local edits trigger a background pass;
the periodic check discovers remote edits in directions that permit downloads.

**Before you start:** use desktop Obsidian **1.11.4 or newer** (required for
keychain token storage), install a working
system `git` executable, and have a GitLab or GitHub repository you can access.
MUGS is not a mobile plugin or a full replacement for Obsidian Sync. Its Git
transport does not use your SSH keys. Use a private repository for private notes.

Choose your provider: [GitLab](gitlab.md) · [GitHub](github.md).

## Install from BRAT (published GitHub releases)

BRAT reads **GitHub releases**, not the GitLab source repository or a developer's
local build. The verified public distribution repository is
[`arikamidotnet/MUGS-obsidian`](https://github.com/arikamidotnet/MUGS-obsidian/releases).
At the time this guide was written, **0.4.13 is the latest published release**.
Choose only a version that appears on the linked Releases page and has matching
`main.js`, `manifest.json`, and `styles.css` assets. Do not interpret a local
version number or a GitLab tag as proof that BRAT can install it.

1. In **Obsidian → Settings → Community plugins**, allow community plugins.
   Select **Browse**, search for **BRAT**, install it and enable it.
2. Open **Settings → BRAT** and choose **Add Beta plugin** (or run BRAT's
   **Add a beta plugin for testing** command). Enter
   `https://github.com/arikamidotnet/MUGS-obsidian` or
   `arikamidotnet/MUGS-obsidian`. Choose a **frozen** version matching the
   specific published release approved for your team, rather than tracking
   Latest on a production vault. Confirm the installation; if it initially
   tracks Latest, use the plugin's **edit** control in BRAT's beta-plugin list
   to freeze it to that release before accepting updates.
3. In **Settings → Community plugins**, enable **MUGS — Multi-User Git Sync**
   if BRAT did not enable it. Open **Settings → MUGS** and confirm the About
   version matches the release you selected.

BRAT's optional **GitHub download token** is only needed for a *private plugin
distribution repository* or GitHub API rate limits. It is distinct from the
**MUGS account token** that grants access to your notes repository. Do not give
BRAT your MUGS token merely to connect a GitLab or GitHub notes repository.
BRAT updates plugin files, not your vault notes. [BRAT's developer guide][brat]
explains release selection, frozen versions and private distributions.

## Manual install or update

Use this when BRAT is unavailable or when an operator is validating an
unpublished candidate. Back up **the full vault**, including
`.obsidian/plugins/mugs-obsidian/data.json` and `.mugs-clones/`, before an
upgrade; plugin state may contain plaintext access tokens. Keep that backup
private. In MUGS **Settings → Sync**, enable **Pause automatic sync** and click
**Apply settings**. Wait for any running pass to finish, then disable MUGS under
Community plugins before replacing files. Do not delete or reset a clone.

Download `main.js`, `manifest.json`, `styles.css` and `checksums.txt` from the
*same* [GitHub release](https://github.com/arikamidotnet/MUGS-obsidian/releases).
Verify the three assets with the release's `checksums.txt` before copying them
to `<vault>/.obsidian/plugins/mugs-obsidian/` (create that directory if this is
a first install). On Linux, from the directory containing those four files,
`sha256sum -c checksums.txt` checks integrity. On other systems use a SHA-256
utility and compare each asset's digest to the release listing. **Copy only
the three plugin assets**; do not replace `data.json` or `.mugs-clones/`.
Re-enable/reload MUGS, verify the displayed version and mappings, then resume
only when the existing state is safe.

For a source build, clone the repository into a *separate* development
directory, run `npm ci` and `npm run build`, and copy those three built assets
as above. A source build is not a signed/published release. Node 20.19+ is
required for development, not for using a published bundle.

Rollback requires the **matching previous assets and compatible saved
settings/state**. Preserve newer legitimate edits and pending work rather than
blindly replacing the entire vault from an old backup. Ask an operator to
inspect dirty/unpushed clones before any recovery; never force-push.

## Connect your first folder

1. Back up your vault and repository. Agree with collaborators on the target
   repository, branch and which top-level folder belongs to which person.
   If both sides already contain files, compare them **before** connecting.
2. In **Settings → MUGS → Accounts → Add another account**, select GitLab or
   GitHub. Everything possible is filled in for you: the **Base URL** (API
   endpoint) and the **Label** are set from the provider. All you need is the
   **Token** (and a **Username** if you like). Values are checked as you type (a
   malformed URL or repo path is flagged inline), and **Test connection** probes
   the account before you commit. For a repository-restricted token, enter the
   exact `owner/repo` or `group/project` under **Allowed repositories**, one per
   line. Press **Add account** — settings save automatically.
3. Under **Connected folders → Connect another folder**, select your account
   and repository. MUGS suggests matches between **top-level repository
   directories** and **top-level vault folders**. Check the intended matching
   folder; if none match, create the intended folder on both sides, then reopen
   the mapping form. Avoid **Sync the entire repository to the vault root**
   unless the whole vault is explicitly meant to be shared.
4. Set **Direction**: **Both ways** for collaborative upload and download,
   **Upload only** if the repository must never update this vault, or
   **Download only** if this device must never publish. Leave **Branch** empty
   for the repository default, or name the intended *existing* branch. Review
   **Only sync matching files** and **Skip matching files**; empty filters mean
   all otherwise eligible files in the mapping. Press **Connect selected
   folders**. Settings save automatically; the banner counts any pending changes
   and lists anything that must be fixed, with each problem clickable to jump to
   it.
5. Sync starts on its own — no pause step, no routine **Sync now** click. Check
   the route on the connected-folder card and, if you want, choose
   **Sync → Start new connections with**: **Download from repository** (default)
   or **Upload from this device**. Both operate only within the configured
   direction and scope; neither is an overwrite guarantee or a substitute for a
   backup. To stop automatic sync at any time, turn on **Pause automatic sync**
   under Sync.

Use **MUGS Overview** to inspect each folder, **Diff** for committed
snapshots, **Review** for repository files that need a decision, and **Conflicts**
for genuine merge decisions.
A row showing **needs review**, **pending**, **skipped** or **failed** is *not*
fully in sync. Review decisions are manual; neither a same-name file nor a
completed pass authorizes an automatic deletion. See
[guided rollout](rollout.md) for the team rollout workflow.

## Confirm background sync, then leave it alone

In a fresh disposable mapping, create a uniquely named `.md` note inside the
mapped folder, save and close it, and **do not** press Sync now. Wait for the
background pass and confirm the same file and bytes appear in the intended
remote folder and branch. Check Overview and Review for pending work. For
**Both ways**, create a different test note in the remote folder and wait for
the ordinary periodic check (default every 30 seconds, evaluated on a 15
second tick). **Upload only never downloads remote edits**; do not use it to
test inbound sync. Do not conduct this exercise in a real team vault that has
unresolved Review items or an unknown clone state.

After setup, normal local changes coalesce into a scheduled pass; you should
interact only when Overview reports an exception. Sync now remains available
even while automatic sync is paused, so do not press it while investigating
an unsafe mapping. Hidden windows, offline hosts, expired tokens and
conflicts can postpone completion; keep a separate backup and check status.

## Common problems

- **No repositories listed:** confirm the token is active and has access to
  the *same* host and repository, check the API Base URL, and enter its exact
  namespace under Allowed repositories for a project-scoped token. **Test
  connection** in the account form reports the provider's real error.
- **No folders suggested:** MUGS matches existing *top-level* directories on
  both sides. Check spelling/case, create the intended directories if needed,
  then reopen the mapping form. Do not select the whole-vault checkbox simply
  to work around missing folder suggestions.
- **403/404 or push rejected:** check token approval, repository role, branch
  protections/rulesets and that the target branch exists. See the host guide.
- **Not syncing:** check the status bar and Overview. Automatic sync runs by
  default (near real-time); if **Pause automatic sync** is on, turn it off.
  **Sync now** always works, even while paused.
- **Needs review:** a teammate's newly added file is **pulled automatically**
  for Both ways / Download only; Review only lists genuinely ambiguous paths (a
  file this vault had proven and then lost while the remote changed). Inspect
  each path and decide whether to recover or delete it; do not batch-approve
  unknown content. **Needs merge:** use Conflicts to choose a winner.
  **Pending:** close open editors and let a later pass verify; do not delete the
  clone.
- **Missing attachments or settings:** MUGS is presently a desktop text-sync
  product. Binary attachments and full `.obsidian/` configuration syncing
  are not release-ready; do not rely on MUGS as the only backup.

## Token and privacy limits

On Obsidian 1.11.4+, MUGS stores account tokens in Obsidian's built-in
**SecretStorage** (the OS keychain) and keeps only a reference in this vault's
plugin `data.json`. Secrets are **device-local** — they are not synced with the
vault, so a second device must re-enter each token. On older builds, tokens
fall back to `data.json`, where **encryption at rest is off by default**: in
**Settings → MUGS → Security** you can set a passphrase and enable **Encrypt
saved tokens**; you must unlock tokens after every app
start, and losing the passphrase requires re-entering tokens. This is **not
vault-content end-to-end encryption**. Do
not put tokens in a note, terminal argument, Git remote URL, screenshot or
issue report. Grant each teammate their own least-privilege host token and
revoke it on departure.

[brat]: https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md
