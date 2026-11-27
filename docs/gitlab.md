# Connect a GitLab repository

Start with [installation and the first-folder walkthrough](getting-started.md).
These steps apply to GitLab.com and self-managed GitLab with a working HTTPS
Git endpoint and v4 REST API.

## Create or choose the repository

Use a **private** project for private vault notes. Confirm your GitLab user
has access to the project and to the intended branch. To upload, the user
needs push rights (normally Developer or above on an unprotected branch);
branch protection can still deny a push. A read-only role cannot enable
uploads, even with a token that has broad scopes. Before connecting an
existing folder, back up both sides and agree on which repository top-level
directory it maps to. If creating a new project, initialize its default
branch and add the intended top-level directory with a harmless file; an
empty Git directory does not exist in the repository tree.

## Sign in with GitLab (OAuth 2.0)

MUGS supports GitLab OAuth 2.0 (Authorization Code + PKCE, no client secret)
alongside manual access tokens, with automatic background token refresh:

1. In GitLab (**Edit profile → Access → Applications**, or a Group/Instance
   Application), create a **non-confidential** OAuth application with:
   - **Redirect URI:** `http://127.0.0.1:47291/callback`
   - **Scopes:** `read_api`, `write_repository`, `read_user`
2. In **Settings → MUGS → Accounts → Add another account**, choose **GitLab**
   and select **Sign in with GitLab (OAuth)**. Paste the **Application ID
   (Client ID)** (optionally set **Allowed repositories** under **Advanced
   options** to restrict MUGS to a single project such as `group/project`), and
   click **Sign in with GitLab**.
3. If an OAuth grant is ever revoked or opened on a second device, click
   **Reconnect with GitLab** on the existing account card to refresh the session
   in place without touching connected folders.

## Create a GitLab token (PAT / Project token)

Prefer the least-privilege token that works — **not** the full `api` scope:

1. **Best: a project access token** (self-managed any tier; GitLab.com
   Premium/Ultimate) or a fine-grained personal token scoped to the *one*
   project you are syncing. Grant **`read_api` + `write_repository`** — REST
   discovery plus Git-over-HTTPS push/pull, nothing else (no issues, MRs, CI or
   settings access).
2. Otherwise, in GitLab open your avatar → **Edit profile → Access → Personal
   access tokens** (or just use the **Create token in GitLab ↗** link inside
   MUGS's add-account form, which prefills exactly these scopes). Name it for
   this device, set an expiry, and record the rotation date. GitLab shows the
   value once; store it privately.
3. Avoid the full **`api`** scope unless you specifically need it: it grants
   read/write to every project, group, registry and CI setting your account can
   reach, which turns a leaked token into a much bigger incident.
4. In **Settings → MUGS → Accounts → Add another account**, select
   **GitLab**, paste the token into **Token** (the **Label** is filled in for
   you; edit it if you like) and optionally supply your GitLab **Username**. The token is not
   your GitLab login password. **Base URL** is filled in automatically as
   `https://gitlab.com/api/v4`; for a self-managed host change it to
   `https://your-gitlab-host.example/api/v4`. Do not enter a project page or a
   Git clone URL in Base URL — MUGS flags a website URL inline and suggests the
   API endpoint. Use **Test connection** to confirm the account before adding it.
5. Optionally enter `group/project` (or `group/subgroup/project`) in
   **Allowed repositories**, one per line. This pins MUGS to that single
   repository (the picker lists only it) and works with OAuth accounts too —
   particularly useful for a project-scoped token, where global enumeration
   may not work. Press **Add account** — settings save automatically, so you
   can go straight on to connecting a folder.

GitLab personal tokens expire and must be rotated. To rotate or fix a token
without breaking connected folders, open **Settings → MUGS → Accounts**, click
**Update token** on the existing account, paste the new token, and press
**Test & Save** (or use **Create token in GitLab ↗** to open GitLab's prefilled
token page). Do not edit `data.json` by hand.

## Connect and verify

Under **Connected folders → Connect another folder**, select the GitLab
account, pick the project, check only intended top-level matching folders,
choose the direction and branch, and press **Connect selected folders**.
Settings save automatically and sync starts on its own — no pause step. Choose
**Sync → Start new connections with** after comparing the two sides. Use a disposable note and
verify automatic upload as described in the
[setup guide](getting-started.md#confirm-background-sync-then-leave-it-alone).

If the project does not appear, check host/API URL, project membership and
Allowed repositories. If branch discovery fails, ensure the branch exists
and is visible to the token. If a push is rejected, check the **project's
protected-branch rules** and your role, not just token scope. For 401/403
after working setup, check expiry or revocation and whether your
organization requires fresh access approval. Offline or unavailable hosts
must show a retry/skip state, not be mistaken for full sync.

Official references: [GitLab token creation][pat],
[scope matrix][scopes], [GitLab HTTPS authentication][https], and
[protected branches][branches].

[pat]: https://docs.gitlab.com/user/profile/personal_access_tokens/
[scopes]: https://docs.gitlab.com/security/tokens/access_token_scopes/
[https]: https://docs.gitlab.com/topics/git/clone/
[branches]: https://docs.gitlab.com/user/project/repository/branches/protected/
