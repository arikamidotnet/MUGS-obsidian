/**
 * Two-mapping shared-repo fixture builder.
 * Creates one bare remote and two mappings that point at the same repo
 * but different localFolders (or the same), exercising shared-clone behavior.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticExecSync } from "./gitHermetic";
import type { FolderMapping, Credential } from "../../types";

export interface TwoMappingSharedRepo {
  base: string;
  remotePlain: string;
  mappingA: FolderMapping;
  mappingB: FolderMapping;
  cred: Credential;
  cleanup: () => void;
}

export function makeTwoMappingSharedRepo(): TwoMappingSharedRepo {
  const base = mkdtempSync(join(tmpdir(), "mugs-twomap-"));
  const remotePlain = join(base, "remote.git");
  const work = join(base, "work");
  rmSync(base, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "shared.md"), "shared\n");
  hermeticExecSync(`git init -q -b main "${work}"`);
  hermeticExecSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
  hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
  hermeticExecSync(`git clone -q --bare "${work}" "${remotePlain}"`);
  rmSync(work, { recursive: true, force: true });

  const cred: Credential = { id: "c", label: "L", kind: "local", token: "t", baseUrl: "file://" + remotePlain };
  const mappingA: FolderMapping = { id: "m1", label: "M1", remotePath: "", localFolder: "A", providerId: "c", direction: "push-pull" };
  const mappingB: FolderMapping = { id: "m2", label: "M2", remotePath: "", localFolder: "B", providerId: "c", direction: "push-pull" };
  return {
    base,
    remotePlain,
    mappingA,
    mappingB,
    cred,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
