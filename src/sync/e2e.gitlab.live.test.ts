/**
 * END-TO-END live test: mirror the user's exact scenario against real GitLab.
 * Builds a store-backed credential + whole-repo mapping for fbr-rom/FBR-WRK using
 * the SAME id the settings UI stores (r.id from listRepos), then runs the full
 * syncAllMappings path to see whether it succeeds or skips with "repo not found".
 * Proves the driver's repo-matching logic works end-to-end.
 *
 * Run: GITLAB_TOKEN=<pat> npx vitest run src/sync/e2e.gitlab.live.test.ts --reporter=verbose
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor } from "./driver";
import { ChildProcessRunner } from "../git/runner";
import { GitLabProvider } from "../providers/gitlab";
import { MugsStore } from "../store";
import { buildProvider } from "../providers/factory";
import type { FolderMapping, Credential } from "../types";

const TOKEN = process.env.GITLAB_TOKEN ?? "";
const CLONE_ROOT = mkdtempSync(join(tmpdir(), "mugs-e2e-gitlab-"));

/** Reproduce exactly what settingsTab stores: listRepos -> pick repo -> id = r.id. */
async function buildRealMapping(): Promise<{ mapping: FolderMapping; credential: Credential }> {
  const provider = new GitLabProvider({ baseUrl: "https://gitlab.com/api/v4", token: TOKEN });
  const repos = await provider.listRepos();
  const chosen = repos.find((r) => r.pathWithNamespace === "fbr-rom/FBR-WRK");
  if (!chosen) throw new Error(`repo fbr-rom/FBR-WRK not in listRepos (${repos.length} repos)`);

  // Whole-repo mapping: id === repo.id (matches driver line 147).
  const mapping: FolderMapping = {
    id: chosen.id,
    label: "FBR WRK",
    remotePath: "",
    localFolder: ".",
    providerId: chosen.id,
    direction: "push-pull",
    repoRef: chosen.id,
  };

  const credential: Credential = {
    id: chosen.id, // settings UI stores repoRef/id from r.id (numeric string for GitLab)
    label: "fbr-rom/FBR-WRK",
    kind: "gitlab",
    token: TOKEN,
    baseUrl: "https://gitlab.com/api/v4",
  };

  return { mapping, credential };
}

describe.skipIf(!TOKEN)("e2e — full syncAllMappings against real GitLab (fbr-rom/FBR-WRK)", () => {
  it("does NOT skip with 'repo not found or not accessible'", async () => {
    const { mapping, credential } = await buildRealMapping();

    // Seed the store via upsert so getToken() resolves the real token.
    const store = new MugsStore();
    store.upsertCredential(credential);
    store.upsertMapping(mapping);
    const settings = store.getSettings();

    const outcomes = await syncAllMappings({
      mappings: settings.mappings,
      credentials: settings.credentials,
      getToken: (id) => store.getToken(id),
      buildProvider,
      cloneRoot: CLONE_ROOT,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(store),
      workingTree: { writeFile: async () => {} },
      conflicts: storeConflictAccessor(store),
      editorOpen: undefined as never,
    });
    console.log(`mapping.id=${mapping.id} repoRef=${mapping.repoRef} providerId=${mapping.providerId}`);
    console.log(`outcomes: ${JSON.stringify(outcomes.map((o) => ({ status: o.status, reason: o.reason })))}`);
    expect(outcomes.length).toBe(1);
    // The bug we're hunting: a skip with "repo not found or not accessible".
    // Assert the repo was FOUND and matched (id === r.id), independent of whether
    // git clone can authenticate in this sandbox. A skip for any other reason
    // (e.g. missing token, git auth) is expected here and NOT what we're guarding.
    if (outcomes[0].status === "skipped") {
      expect(outcomes[0].reason).not.toContain("repo not found");
    } else {
      expect(outcomes[0].status).toBe("ok");
    }
  }, 60000);
});
