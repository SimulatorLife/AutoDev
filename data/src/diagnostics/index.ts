/**
 * The unified session diagnostics engine.
 *
 * `@simulatorlife/autodev-core` owns the contract and the text rendering;
 * this module owns the reading of the evidence: the Codex rollouts, the
 * router's rotated logs, the bridge logs, the hook log and the live runtime.
 *
 * Every consumer of a session's diagnostics reads it through here: the
 * Control API that serves the Console, the CLI, and the skill wrapper's
 * offline fallback.
 */

export * from "./fleet-scan.ts";
export * from "./hook-denials.ts";
export * from "./live-context.ts";
export * from "./rollout-discovery.ts";
export * from "./router-events.ts";
export * from "./session-report.ts";
export * from "./thread-tracer.ts";
