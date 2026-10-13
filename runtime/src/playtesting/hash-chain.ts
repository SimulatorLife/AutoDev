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
}): Readonly<{
  readonly rubricHash: string;
  readonly metricRegistryHash: string;
  readonly observationSchemaHash: string;
}> {
  return {
    rubricHash: input.rubricHash,
    metricRegistryHash: input.rubricHash,
    observationSchemaHash: input.observationSchemaHash
  };
}

/**
 * The observation contract's content hash, computed over everything except the
 * `schemaHash` field itself — otherwise the digest could never be written into
 * the file it describes.
 */
export function observationSchemaHash(
  contract: Omit<PlaytestObservationContract, "schemaHash">
): string {
  const { schemaHash: _omitted, ...content } =
    contract as PlaytestObservationContract;
  return playtestManifestHash(content);
}

/** True when the file's recorded digest matches its own content. */
export function observationSchemaHashMatches(
  contract: PlaytestObservationContract
): boolean {
  return (
    contract.schemaHash.toLowerCase() ===
    observationSchemaHash(contract).toLowerCase()
  );
}

/** The contract with its digest filled in, ready to serialize. */
export function withObservationSchemaHash(
  contract: Omit<PlaytestObservationContract, "schemaHash">
): PlaytestObservationContract {
  return { ...contract, schemaHash: observationSchemaHash(contract) };
}
