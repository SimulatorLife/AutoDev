import type { PlaytestJsonValue } from "./protocol-types.ts";
import { PLAYTESTS_SEVERITIES, type PlaytestSeverity } from "./types.ts";

const SHA256_HEX_PATTERN = /^[a-f\d]{64}$/iu;
const EVENT_TAXONOMY_KEYS = [
  "schemaVersion",
  "workspaceId",
  "taxonomyVersion",
  "eventSchemaHash",
  "events"
] as const;
const EVENT_DEFINITION_KEYS = [
  "eventId",
  "eventType",
  "mechanicKey",
  "phaseId",
  "stepField",
  "revisionField",
  "actorField",
  "eligibilityFlags",
  "source",
  "thresholds",
  "severity",
  "expectedOccurrenceRange"
] as const;

export interface PlaytestEventDefinition {
  readonly eventId: string;
  readonly eventType: string;
  readonly mechanicKey: string;
  readonly phaseId: string;
  readonly stepField: string;
  readonly revisionField: string;
  readonly actorField: string | null;
  readonly eligibilityFlags: readonly string[];
  readonly source:
    | { readonly kind: "game"; readonly emitterId: string }
    | {
        readonly kind: "detector";
        readonly detectorRef: string;
        readonly codeHash: string;
      };
  readonly thresholds: Readonly<Record<string, PlaytestJsonValue>>;
  readonly severity: PlaytestSeverity;
  readonly expectedOccurrenceRange: {
    readonly minimum: number;
    readonly maximum: number;
  } | null;
}

export interface PlaytestEventTaxonomy {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly taxonomyVersion: string;
  readonly eventSchemaHash: string;
  readonly events: readonly PlaytestEventDefinition[];
}

function isPlainRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

function isSeverity(value: unknown): value is PlaytestSeverity {
  return (
    typeof value === "string" &&
    (PLAYTESTS_SEVERITIES as readonly string[]).includes(value)
  );
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string
): void {
  const known = new Set(allowed);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new TypeError(label + " contains an unknown field.");
  }
}

function assertEventSource(source: unknown): void {
  if (!isPlainRecord(source)) {
    throw new TypeError(
      "Event source must be game-owned or a versioned detector."
    );
  }
  if (source.kind === "game") {
    assertOnlyKeys(source, ["kind", "emitterId"], "Game event source");
    if (!nonEmpty(source.emitterId)) {
      throw new TypeError("Game event emitterId must be non-empty.");
    }
    return;
  }
  if (source.kind === "detector") {
    assertOnlyKeys(
      source,
      ["kind", "detectorRef", "codeHash"],
      "Detector event source"
    );
    if (!nonEmpty(source.detectorRef) || !isHash(source.codeHash)) {
      throw new TypeError(
        "Detector event source requires detectorRef and a SHA-256 codeHash."
      );
    }
    return;
  }
  throw new TypeError("Event source kind is not supported.");
}

function assertExpectedOccurrenceRange(value: unknown): void {
  if (value === null) return;
  if (!isPlainRecord(value)) {
    throw new TypeError("Expected occurrence range must be an object or null.");
  }
  assertOnlyKeys(value, ["minimum", "maximum"], "Expected occurrence range");
  if (
    !Number.isFinite(value.minimum) ||
    !Number.isFinite(value.maximum) ||
    (value.minimum as number) < 0 ||
    (value.maximum as number) < (value.minimum as number)
  ) {
    throw new TypeError(
      "Expected occurrence range must be non-negative and ordered."
    );
  }
}

function assertEventDefinition(value: unknown, eventIds: Set<string>): void {
  if (!isPlainRecord(value))
    throw new TypeError("Event definition must be an object.");
  assertOnlyKeys(value, EVENT_DEFINITION_KEYS, "Event definition");
  for (const key of [
    "eventId",
    "eventType",
    "mechanicKey",
    "phaseId",
    "stepField",
    "revisionField"
  ]) {
    if (!nonEmpty(value[key]))
      throw new TypeError("Event definition " + key + " must be non-empty.");
  }
  if (value.actorField !== null && !nonEmpty(value.actorField)) {
    throw new TypeError(
      "Event actorField must be a non-empty field name or null."
    );
  }
  const eventId = value.eventId as string;
  if (eventIds.has(eventId))
    throw new TypeError("Event definition IDs must be unique.");
  eventIds.add(eventId);
  if (
    !Array.isArray(value.eligibilityFlags) ||
    !value.eligibilityFlags.every(nonEmpty)
  ) {
    throw new TypeError(
      "Event eligibilityFlags must be an array of non-empty names."
    );
  }
  assertEventSource(value.source);
  if (!isPlainRecord(value.thresholds))
    throw new TypeError("Event thresholds must be a JSON object.");
  if (!isSeverity(value.severity))
    throw new TypeError("Event severity is invalid.");
  assertExpectedOccurrenceRange(value.expectedOccurrenceRange);
}

/** Validate the game-owned event taxonomy without inventing absent labels. */
export function assertPlaytestEventTaxonomy(
  value: unknown
): asserts value is PlaytestEventTaxonomy {
  if (!isPlainRecord(value))
    throw new TypeError("Event taxonomy must be an object.");
  assertOnlyKeys(value, EVENT_TAXONOMY_KEYS, "Event taxonomy");
  if (value.schemaVersion !== 1)
    throw new TypeError("Event taxonomy schemaVersion must be 1.");
  if (!nonEmpty(value.workspaceId) || !nonEmpty(value.taxonomyVersion)) {
    throw new TypeError(
      "Event taxonomy requires workspaceId and taxonomyVersion."
    );
  }
  if (!isHash(value.eventSchemaHash))
    throw new TypeError("eventSchemaHash must be a SHA-256 digest.");
  if (!Array.isArray(value.events))
    throw new TypeError("Event taxonomy events must be an array.");
  const eventIds = new Set<string>();
  for (const event of value.events) assertEventDefinition(event, eventIds);
}
