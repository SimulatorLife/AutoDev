/**
 * Barrel for the Core-owned playtesting contract.
 *
 * Infrastructure-free: no Runtime/Data/Console imports, no network, no
 * filesystem. See docs/playtesting-target-state.md and
 * docs/playtesting-measurement-contract.md for the normative design this
 * module implements.
 */

export * from "./artifacts.ts";
export * from "./compatibility.ts";
export * from "./comparison.ts";
export * from "./configuration.ts";
export * from "./evaluators.ts";
export * from "./evidence.ts";
export * from "./human-study-aggregation.ts";
export * from "./human-study-import.ts";
export * from "./observability.ts";
export * from "./operation-validation.ts";
export * from "./protocol.ts";
export * from "./protocol-types.ts";
export * from "./registry.ts";
export * from "./sampling.ts";
export * from "./scoring.ts";
export * from "./types.ts";
