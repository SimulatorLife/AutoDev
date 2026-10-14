/**
 * Canonical hash chain for a Playtesting integration.
 *
 * These digests are computed here rather than written by the game. A
 * hand-maintained digest silently invalidates a run when an evaluator or schema
 * is edited, which is why generation and verification share one owner: `check`
 * writes what it verifies, and approval reads the same values.
 *
 * Encoding is delegated to the canonical Playtesting JSON the rest of the
 * pipeline already hashes with, so a manifest cannot be hashed one way here and
 * another way at approval.
 *
 * It lives in the Runtime because it digests bytes the Runtime reads off disk,
 * and because Core is imported by the Console's client bundle: Core stays
 * resolvable in a browser, so a Node built-in cannot enter it.
 * `tests/cli/platform-import-boundary.test.ts` holds that boundary.
 */
import { createHash } from "node:crypto";

import {
  canonicalPlaytestJson,
  type PlaytestBenchmark,
  playtestBenchmarkHashInput,
  type PlaytestJsonSchema,
  type PlaytestObservationContract
} from "@simulatorlife/autodev-core";

export function playtestManifestHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalPlaytestJson(value))
    .digest("hex");
}

/**
 * The digest the approval path records for the rubric.
 *
 * It hashes the file's own bytes rather than a canonical re-encoding, because
 * approval compares against bytes it read from the approved checkout. Generation
 * and verification must agree with it exactly, so a differently-encoded but
 * equivalent registry is a real difference here.
 */
export function playtestFileHash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every digest field a benchmark carries that AutoDev derives, not the game. */
export function derivedBenchmarkDigests(input: {
  readonly rubricHash: string;
  readonly observationSchemaHash: string;
  readonly actionSchemaHash: string;
  readonly eventSchemaHash: string;
}): Readonly<{
  readonly rubricHash: string;
  readonly metricRegistryHash: string;
  readonly observationSchemaHash: string;
  readonly actionSchemaHash: string;
  readonly eventSchemaHash: string;
}> {
  return {
    rubricHash: input.rubricHash,
    metricRegistryHash: input.rubricHash,
    observationSchemaHash: input.observationSchemaHash,
    actionSchemaHash: input.actionSchemaHash,
    eventSchemaHash: input.eventSchemaHash
  };
}

/** SHA-256 over Core's canonical benchmark projection, excluding contentHash. */
export function playtestBenchmarkContentHash(
  benchmark: Omit<PlaytestBenchmark, "contentHash">
): string {
  return createHash("sha256")
    .update(playtestBenchmarkHashInput(benchmark))
    .digest("hex");
}

/**
 * The exact player-visible observation JSON Schema digest. The contract's
 * `schemaHash` links its allowlist to the schema the adapter advertises; it is
 * not a hash of the contract metadata, which is independently pinned by the
 * approved clean checkout SHA.
 */
export function observationSchemaHash(schema: PlaytestJsonSchema): string {
  return playtestManifestHash(schema);
}

/** True when the contract points at the adapter's declared observation schema. */
export function observationSchemaHashMatches(
  contract: PlaytestObservationContract,
  schema: PlaytestJsonSchema
): boolean {
  return (
    contract.schemaHash.toLowerCase() ===
    observationSchemaHash(schema).toLowerCase()
  );
}

/** The contract linked to the adapter schema, ready to serialize. */
export function withObservationSchemaHash(
  contract: Omit<PlaytestObservationContract, "schemaHash">,
  schema: PlaytestJsonSchema
): PlaytestObservationContract {
  return { ...contract, schemaHash: observationSchemaHash(schema) };
}
