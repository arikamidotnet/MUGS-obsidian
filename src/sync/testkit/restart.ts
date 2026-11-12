/**
 * Restart simulation helper.
 * Writes a minimal data.json shape that the store can rehydrate from,
 * then re-creates a MugsStore pointed at it.
 * Useful for engine-wave restart/resume regression.
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MugsStore } from "../../store";

export interface RestartSnapshot {
  dir: string;
  dataPath: string;
  store: MugsStore;
  cleanup: () => void;
}

/** Create a temp dir, write a data.json, and return a hydrated store. */
export async function makeRestartStore(initial: Record<string, unknown>): Promise<RestartSnapshot> {
  const dir = join(process.env.TMPDIR || "/tmp", `mugs-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const dataPath = join(dir, "data.json");
  writeFileSync(dataPath, JSON.stringify(initial));
  const store = new MugsStore({ read: async () => JSON.parse(require("fs").readFileSync(dataPath, "utf8")), write: async () => {} });
  await store.load();
  return {
    dir,
    dataPath,
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
