/**
 * Barrel for the Core-owned playtesting contract.
 *
 * Infrastructure-free: no Runtime/Data/Console imports, no network, no
 * filesystem. See docs/playtesting-target-state.md and
 * docs/playtesting-measurement-contract.md for the normative design this
 * module implements.
 */

export * from "./comparison.ts";
export * from "./evaluators.ts";
export * from "./evidence.ts";
export * from "./protocol.ts";
export * from "./registry.ts";
export * from "./sampling.ts";
export * from "./scoring.ts";
export * from "./types.ts";
