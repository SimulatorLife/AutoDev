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
 */
import { createHash } from "node:crypto";

import type { PlaytestObservationContract } from "./artifacts.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";

export function playtestManifestHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalPlaytestJson(value))
    .digest("hex");
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