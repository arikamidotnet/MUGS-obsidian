# Connect a GitHub repository

Start with [installation and the first-folder walkthrough](getting-started.md).
The MUGS GitHub account token is for the **notes repository**. It is not the
optional BRAT token used to download the plugin's release assets.

## Create or choose the repository

Choose a **private** repository for private vault notes and ensure your
GitHub account can push to its intended branch if using Both ways or Upload
only. Initialize a new repository with a default branch and an intended
top-level directory containing a file; empty Git directories do not appear
in MUGS's folder suggestions. Check repository rulesets/branch protection:
having token write permission does not override an enforced push policy.
Back up the existing vault and repository before connecting a folder that
already has content.

## Create a fine-grained token

1. In GitHub, open your avatar → **Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token**.
   Name it for this device, set an expiry, choose the **Resource owner** of
   the notes repository and choose **Only select repositories** with that
   repository selected. For an organization, wait for required owner approval.
2. Under **Repository permissions**, grant **Contents: Read and write** for
   uploads, or **Contents: Read-only** for a Download only mapping. GitHub
   includes Metadata read access. The owner must also grant your account
   access to the repository/branch. Check any organization's fine-grained
   token policy and approval flow; if fine-grained tokens cannot access an
   outside-collaborator repository, see GitHub's [token limitations][tokens]
   and ask the repository owner for a supported access method rather than
   granting an unrestricted token by default.
3. In **Settings → MUGS → Accounts → Add another account**, choose
   **GitHub**, give it a **Label**, paste the token in **Token** and enter
   your GitHub **Username**. **Base URL** is
   `https://api.github.com` for GitHub.com or normally
   `https://your-enterprise-host.example/api/v3` for GitHub Enterprise
   Server. Verify the server's documented API base; do not paste a browser
   repository page URL.
4. Put `owner/repo` in **Allowed repositories**, one per line. This lets a
   repository-scoped token discover precisely the repository without
   enumerating everything under `/user/repos`. This field affects the
   picker, **not** the token's actual GitHub permissions. Click
   **Add account** and **Apply settings** (or stage the mapping and Apply
   both at once). Do not paste your token into the Allowed repositories box.

For a classic token when a fine-grained token is not supported, GitHub's
`repo` scope grants *broad* private-repository access; use it only when
required by an administrator's policy, and authorize organization SSO if
needed. Set an expiry and rotate it. MUGS currently has no in-place token
editor; do not remove an account linked to live mappings without planning
how to preserve their state.

## Connect and verify

Under **Connected folders → Connect another folder**, select the GitHub
account and repository, choose matching *top-level* folders, set direction
and the existing branch (or leave blank for default), then press
**Connect selected folders** and **Apply settings**. Set **Sync → Start new
connections with** after comparing the two sides. A first mapping made
with the current candidate stays paused until you inspect it and resume
automatic sync. Published 0.4.2 users should pause explicitly before
connecting for the same safety gate. Confirm event-driven upload without
Sync now using a disposable file as in the [setup guide](getting-started.md#confirm-background-sync-then-leave-it-alone).

If the repository is missing, confirm the token's resource owner, selected
repo, Contents permission, approval, Base URL and Allowed repositories.
A 404 may mean *inaccessible* rather than nonexistent; 403 can also indicate
organization policy, rate limits or SSO authorization. If uploads fail,
check branch protection/rulesets and write access. If a directory is missing,
make sure it exists as a committed directory with a file. Do not disable
protections or force-push to make onboarding pass.

Official references: [GitHub token creation and limitations][tokens],
[repository permissions][contents], [HTTPS authentication][https] and
[repository rulesets][rules].

[tokens]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
[contents]: https://docs.github.com/en/rest/repos/contents
[https]: https://docs.github.com/en/get-started/git-basics/about-remote-repositories
[rules]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
