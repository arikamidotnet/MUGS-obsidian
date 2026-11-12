/**
 * Fault-injecting adapters (skeletons) for engine-wave fault testing.
 * Real implementations can subclass or wrap the real seams.
 */
import type { WorkingTreeWriter } from "../cloneManager";
import type { GitRunner, GitResult } from "../../git/types";

export interface FaultOptions {
  failRead?: boolean;
  failWrite?: boolean;
  failDelete?: boolean;
  failGit?: boolean;
}

export function makeFaultyWorkingTree(opts: FaultOptions = {}): WorkingTreeWriter {
  return {
    writeFile: async (p, c) => {
      if (opts.failWrite) throw new Error("fault: write");
      // fallthrough to real FS is left to caller wiring
      return Promise.resolve();
    },
    readFile: async (p) => {
      if (opts.failRead) return undefined;
      return Promise.resolve(undefined);
    },
    deleteFile: (p) => {
      if (opts.failDelete) throw new Error("fault: delete");
      return Promise.resolve();
    },
  };
}

export class FaultyRunner implements GitRunner {
  constructor(private inner: GitRunner, private fail: boolean) {}
  async run(args: string[], opts?: any): Promise<GitResult> {
    if (this.fail) return { code: 1, stdout: "", stderr: "faulty runner" };
    return this.inner.run(args, opts);
  }
}
