/**
 * Barrel for the shared testkit.
 *
 * Re-exports:
 * - Hermetic git identity (process.env + execSync wrapper)
 * - Git-invocation counters (CountingRunner)
 * - Identity-clone dir expectations
 */
export * from "./gitHermetic";
export * from "./counters";
export * from "./cloneDir";
