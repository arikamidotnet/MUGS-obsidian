/**
 * LIVE test: exercise the real GitLabProvider with a real token against gitlab.com.
 * Run: GITLAB_TOKEN=<pat> npx vitest run src/providers/gitlab.live.test.ts --reporter=verbose
 * Proves whether the provider works end-to-end with the user's credentials,
 * independent of any UI/BRAT/Obsidian layer. Skipped unless GITLAB_TOKEN is set.
 */
import { describe, it, expect } from "vitest";
import { GitLabProvider } from "./gitlab";

const TOKEN = process.env.GITLAB_TOKEN ?? "";
const provider = new GitLabProvider({ baseUrl: "https://gitlab.com/api/v4", token: TOKEN });

describe.skipIf(!TOKEN)("GitLabProvider — live (real token)", () => {
  it("lists accessible projects via /projects?membership=true (fast, single page)", async () => {
    const repos = await provider.listRepos();
    console.log(`listRepos count: ${repos.length}`);
    for (const r of repos.slice(0, 12)) console.log(`  - ${r.name} (${r.id})`);
    expect(repos.length).toBeGreaterThan(0);
  }, 30000);

  it("lists branches + directories for fbr-rom/FBR-WRK", async () => {
    const repoId = "fbr-rom/FBR-WRK";
    const branches = await provider.getBranches(repoId);
    console.log(`branches for ${repoId}: ${JSON.stringify(branches)}`);
    expect(branches.length).toBeGreaterThan(0);

    const dirs = await provider.listDirectories(repoId, "");
    console.log(`top-level entries for ${repoId}: ${dirs.slice(0, 25).join(", ")}`);
    expect(dirs.length).toBeGreaterThan(0);
  }, 30000);

  it("lists branches + directories for fbr-rom/mugs-obsidian", async () => {
    const repoId = "fbr-rom/mugs-obsidian";
    const branches = await provider.getBranches(repoId);
    console.log(`branches for ${repoId}: ${JSON.stringify(branches)}`);
    expect(branches.length).toBeGreaterThan(0);

    const dirs = await provider.listDirectories(repoId, "");
    console.log(`top-level entries for ${repoId}: ${dirs.slice(0, 25).join(", ")}`);
    expect(dirs.length).toBeGreaterThan(0);
  }, 30000);
});
