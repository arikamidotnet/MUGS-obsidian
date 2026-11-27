/**
 * MUGS — U04 settings draft/Apply model tests.
 *
 * Pins the contract that Apply validates the COMPLETE draft (safePath traversal +
 * overlap rejection), persists ONCE through the store's setter API, and that a
 * refused/failed save ROLLS BACK so the active settings stay intact.
 */
import { describe, it, expect } from "vitest";
import { SettingsDraft } from "./settingsDraft";
import type { MugsSettings, Credential, FolderMapping } from "../types";
import { DEFAULT_SETTINGS } from "../types";

const cred = (id = "c1"): Credential => ({ id, label: "Work", kind: "gitlab", token: "tok-123" });
const map = (id: string, localFolder: string, providerId = "c1", remotePath = ""): FolderMapping => ({
  id, label: id, remotePath, localFolder, providerId, direction: "push-pull",
});

/** A recording fake store: setters mutate `current`, save returns the scripted result. */
function fakeStore(initial: MugsSettings, saveResult?: { ok: true } | { ok: false; reason: "load-error" }) {
  const calls: string[] = [];
  let current: MugsSettings = structuredClone(initial);
  return {
    calls,
    get settings() { return current; },
    getSettings: () => current,
    upsertCredential: (c: Credential) => {
      calls.push(`upsertCred:${c.id}`);
      current.credentials = current.credentials.filter((x) => x.id !== c.id);
      current.credentials.push(structuredClone(c));
    },
    removeCredential: (id: string) => { calls.push(`removeCred:${id}`); current.credentials = current.credentials.filter((x) => x.id !== id); },
    upsertMapping: (m: FolderMapping) => {
      calls.push(`upsertMap:${m.id}`);
      current.mappings = current.mappings.filter((x) => x.id !== m.id);
      current.mappings.push(structuredClone(m));
    },
    removeMapping: (id: string) => { calls.push(`removeMap:${id}`); current.mappings = current.mappings.filter((x) => x.id !== id); },
    setSecurity: (p: Partial<MugsSettings["security"]>) => { calls.push("setSecurity"); current.security = { ...current.security, ...p }; },
    setSync: (p: Partial<MugsSettings["sync"]>) => { calls.push("setSync"); current.sync = { ...current.sync, ...p }; },
    setObsidianConfig: (c: MugsSettings["sync"]["obsidianConfig"]) => { calls.push("setObsidianConfig"); current.sync.obsidianConfig = c; },
    save: async () => {
      calls.push("save");
      return saveResult ?? { ok: true };
    },
  };
}

function baseSettings(): MugsSettings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.credentials = [cred()];
  s.mappings = [map("m1", "Notes")];
  return s;
}

describe("SettingsDraft — validation of the COMPLETE draft", () => {
  it("accepts a clean draft", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "Journal"));
    expect(d.validate()).toEqual([]);
  });

  it("rejects traversal in a local folder", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "../escape"));
    const problems = d.validate();
    expect(problems.some((p) => p.includes("m2") && p.includes("traversal"))).toBe(true);
  });

  it("rejects absolute local folders and remote paths", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "/etc/passwd"));
    d.upsertMapping(map("m3", "OK", "c1", "/abs/remote"));
    const problems = d.validate();
    expect(problems.some((p) => p.includes("m2"))).toBe(true);
    expect(problems.some((p) => p.includes("m3") && p.includes("remote path"))).toBe(true);
  });

  it("rejects two mappings on the same folder", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "Notes"));
    const problems = d.validate();
    expect(problems.some((p) => p.includes("same folder"))).toBe(true);
  });

  it("rejects nesting overlap (A vs A/B) — including the whole-vault root", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "Notes/Archive"));
    expect(d.validate().some((p) => p.includes("overlap"))).toBe(true);

    const d2 = new SettingsDraft(baseSettings());
    d2.upsertMapping(map("m3", "Other"));
    // Notes + Other is fine...
    expect(d2.validate()).toEqual([]);
    // ...but a whole-vault mapping ("." — remotePath "") overlaps ANYTHING.
    d2.upsertMapping({ id: "m4", label: "all", remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" });
    expect(d2.validate().some((p) => p.includes("overlap"))).toBe(true);
  });

  it("rejects a mapping whose credential does not exist in the draft", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "Other", "ghost-cred"));
    expect(d.validate().some((p) => p.includes("credential missing"))).toBe(true);
  });

  it("rejects credentials without label or token", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertCredential({ id: "c2", label: "", kind: "gitlab", token: "x" });
    d.upsertCredential({ id: "c3", label: "NoToken", kind: "gitlab", token: "" });
    const problems = d.validate();
    expect(problems.length).toBe(2);
  });

  it("accepts a hosted credential whose token lives in the OS keychain (secretId, empty token)", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertCredential({ id: "kc", label: "Keychain", kind: "gitlab", token: "", secretId: "mugs-kc" });
    expect(d.validate()).toEqual([]);
  });

  it("accepts tokenless local repositories with a file URL and rejects a missing path", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertCredential({ id: "local", label: "Local", kind: "local", token: "", baseUrl: "file:///tmp/test.git" });
    expect(d.validate()).toEqual([]);
    d.upsertCredential({ id: "local", label: "Local", kind: "local", token: "" });
    expect(d.validate().some((p) => p.includes("file://"))).toBe(true);
  });

  it("accepts a local credential whose baseUrl is a bare absolute Linux path", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertCredential({ id: "loc", label: "Local", kind: "local", token: "", baseUrl: "/tmp/test.git" });
    expect(d.validate()).toEqual([]);
  });
});

describe("SettingsDraft — commit semantics", () => {
  it("commits via the setter API and saves EXACTLY once", async () => {
    const store = fakeStore(baseSettings());
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "Journal"));
    d.setSync({ intervalSeconds: 600 });
    const res = await d.commit(store);
    expect(res).toEqual({ kind: "saved" });
    expect(store.calls.filter((c) => c === "save")).toHaveLength(1);
    expect(store.settings.mappings.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(store.settings.sync.intervalSeconds).toBe(600);
  });

  it("INVALID draft: nothing is applied and nothing is saved", async () => {
    const store = fakeStore(baseSettings());
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "../escape"));
    const res = await d.commit(store);
    expect(res.kind).toBe("invalid");
    expect(store.calls).toEqual([]); // zero store mutations, zero saves
  });

  it("FAILED save: the store is ROLLED BACK — active settings intact", async () => {
    const store = fakeStore(baseSettings(), { ok: false, reason: "load-error" });
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "Journal"));
    d.removeMapping("m1");
    d.setSync({ paused: true });
    const res = await d.commit(store);
    expect(res.kind).toBe("save-failed");
    // Rollback: the post-apply state (m1 removed) must be undone.
    expect(store.settings.mappings.map((m) => m.id)).toEqual(["m1"]);
    expect(store.settings.sync.paused).toBe(false);
  });

  it("dirty() tracks whether any edit happened", () => {
    const d = new SettingsDraft(baseSettings());
    expect(d.dirty()).toBe(false);
    d.setSync({ intervalSeconds: 900 });
    expect(d.dirty()).toBe(true);
  });

  it("cancel is just: drop the draft — covered by dirty()+view() semantics", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "Temp"));
    expect(d.dirty()).toBe(true);
    // Dropping the object discards everything; the store never saw it.
    const fresh = new SettingsDraft(baseSettings());
    expect(fresh.dirty()).toBe(false);
  });
});

describe("SettingsDraft — changeCount()", () => {
  it("is 0 for an untouched draft", () => {
    expect(new SettingsDraft(baseSettings()).changeCount()).toBe(0);
  });

  it("counts each changed credential/mapping and the sync + security blocks", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "Journal"));       // added mapping
    d.setSync({ intervalSeconds: 600 });          // sync block
    d.setSecurity({ encryptCredentials: true });  // security block
    expect(d.changeCount()).toBe(3);
  });

  it("counts a removed credential", () => {
    const d = new SettingsDraft(baseSettings());
    d.removeCredential("c1");
    expect(d.changeCount()).toBe(1);
  });

  it("counts an edited credential once", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertCredential({ ...cred(), token: "rotated" });
    expect(d.changeCount()).toBe(1);
  });
});

describe("SettingsDraft — validateDetailed() refs", () => {
  it("tags a mapping problem with the mapping id", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "../escape"));
    const p = d.validateDetailed().find((x) => x.message.includes("m2"))!;
    expect(p.ref).toEqual({ kind: "mapping", id: "m2" });
  });

  it("tags a credential problem with the credential id", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertCredential({ id: "c2", label: "", kind: "gitlab", token: "x" });
    const p = d.validateDetailed().find((x) => x.message.includes("c2"))!;
    expect(p.ref).toEqual({ kind: "credential", id: "c2" });
  });

  it("validate() returns exactly the detailed messages", () => {
    const d = new SettingsDraft(baseSettings());
    d.upsertMapping(map("m2", "../escape"));
    expect(d.validate()).toEqual(d.validateDetailed().map((p) => p.message));
  });
});
