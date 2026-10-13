/**
 * Declarative game-adapter bindings.
 *
 * A game used to implement all thirteen protocol methods itself — transport,
 * capability negotiation, revision tracking, event emission, per-phase action
 * enumeration — which is AutoDev-shaped code every game rewrites. A binding
 * names the game's own functions instead; this contract is what the generic
 * runtime dispatches through, and what `autodev playtest check` verifies before
 * a workspace is approved.
 *
 * Nothing here is optional-by-default. A protocol method with no declared
 * binding is an explicit, reported gap rather than a silent fallback, because a
 * runtime that answered from a default would hand the analyst an observation no
 * game actually produced.
 */

/** The protocol methods a binding may supply. */
export const PLAYTESTS_BINDABLE_METHODS = [
  "capabilities",
  "reset",
  "observe",
  "legalActions",
  "step",
  "outcome",
  "invariants",
  "snapshot",
  "replay",
  "fork",
  "captureEvents",
  "captureFrame",
  "cancel"
] as const;

export type PlaytestBindableMethod = (typeof PLAYTESTS_BINDABLE_METHODS)[number];

/**
 * Methods the Runtime cannot proceed without. An adapter missing one is not a
 * lesser adapter; it cannot produce an episode.
 *
 * `capabilities` is absent because AutoDev owns it. The advertisement is
 * derived from the game's declared schemas, so a game that bound its own
 * `capabilities` would have it silently ignored — requiring that binding would
 * ask a game to write a function nothing ever calls.
 */
export const PLAYTESTS_REQUIRED_BINDINGS: readonly PlaytestBindableMethod[] = [
  "reset",
  "observe",
  "legalActions",
  "step",
  "outcome"
];

/**
 * Methods AutoDev answers itself rather than dispatching to the game.
 *
 * A game may still bind these; the derived answer is what is served, so a
 * game's own implementation cannot overwrite the digests AutoDev computed.
 */
export const PLAYTESTS_ADAPTER_OWNED_METHODS: readonly PlaytestBindableMethod[] =
  ["capabilities"];

/**
 * How a bound function is reached on the game object: a property name, or a
 * name plus a dotted path for a factory that returns a namespace.
 */
export interface PlaytestBindingReference {
  /** Property on the object the entry factory returned. */
  readonly export: string;
  /** Optional dotted path when the factory returns a nested namespace. */
  readonly path?: string;
}

export interface PlaytestAdapterBinding {
  readonly schema: typeof PLAYTESTS_ADAPTER_BINDING_SCHEMA;
  readonly schemaVersion: 1;
  /**
   * Onboarding tier, stated rather than assumed. `declarative` means the
   * declarations alone drive the game; `generated-scaffold` means AutoDev
   * generated the bodies and the game filled them in.
   */
  readonly tier: "declarative" | "generated-scaffold";
  /** Module the generic runtime imports, resolved inside the integration directory. */
  readonly entry: string;
  /** Named factory the module exports, called once per adapter process. */
  readonly factory: string;
  /**
   * Bounded seedable RNG entry point. A game that declares one lets AutoDev
   * restore engine RNG state for a counterfactual; one that does not gets
   * reported as unreproducible rather than assumed reproducible.
   */
  readonly seededRng?: PlaytestBindingReference;
  /**
   * The game's own schemas. AutoDev derives their digests rather than reading
   * them from the file, which is what stops a hand-written adapter drifting
   * when a schema is edited.
   */
  readonly schemas: Readonly<{
    readonly observation: Readonly<Record<string, unknown>>;
    readonly action: Readonly<Record<string, unknown>>;
    readonly event: Readonly<Record<string, unknown>>;
  }>;
  readonly bindings: Readonly<Partial<Record<PlaytestBindableMethod, PlaytestBindingReference>>>;
}

export const PLAYTESTS_ADAPTER_BINDING_SCHEMA =
  "autodev-playtest-adapter-binding-v1" as const;

/**
 * AutoDev's own adapter image, pinned.
 *
 * The adapter is AutoDev's protocol code, so it runs in AutoDev's image rather
 * than each game's. The game image is the thing under test, and the game's
 * code reaches the adapter through the approved checkout. This is the same for
 * every onboarded game: two games cannot disagree about what protocol version
 * they are speaking because neither of them supplies it.
 */
export const PLAYTESTS_AUTODEV_ADAPTER_IMAGE_DIGEST =
  "sha256:autodev-playtest-adapter@sha256:" as const;

/**
 * The canonical integration directory a repository declares Playtesting in.
 *
 * One owner, because every consumer resolves against it: the CLI that lays it
 * out, the approved-config loader that reads the config, the sandbox that names
 * it when a checkout is not clean, and the generic adapter that finds the game's
 * binding at run time. A second literal in any of them is a directory that one
 * path creates and another refuses to find.
 */
export const PLAYTESTS_INTEGRATION_DIR = ".autodev";

/**
 * Where the sandbox mounts the approved checkout inside the container.
 *
 * Owned here, beside the adapter command that depends on it: the sandbox mounts
 * here and the adapter resolves its integration directory here, so the two paths
 * are a pair. Changing one without the other would leave the adapter looking
 * outside the mount for a binding that is present.
 */
export const PLAYTESTS_ADAPTER_CONTAINER_WORKSPACE = "/workspace";

/**
 * The command AutoDev's adapter image runs.
 *
 * A game bound through declarations does not declare this; the game under test
 * is reached through the integration directory's binding file. The entrypoint
 * is resolved inside the approved checkout so the sandbox's read-only,
 * SHA-addressed mount is what bounds it.
 */
export const PLAYTESTS_GENERIC_ADAPTER_COMMAND: readonly string[] = [
  "/opt/autodev/playtest-adapter/main.js",
  "--integration-dir",
  PLAYTESTS_INTEGRATION_DIR
];

/** True when this adapter is AutoDev's, not a game-supplied command. */
export function usesGenericPlaytestAdapter(
  command: readonly string[]
): boolean {
  return (
    command.length > 0 &&
    command[0] === PLAYTESTS_GENERIC_ADAPTER_COMMAND[0]
  );
}

export type PlaytestBindingGap = {
  readonly kind: "missing-required";
  readonly method: PlaytestBindableMethod;
  readonly message: string;
};

export type PlaytestBindingResolution =
  | {
      readonly kind: "resolved";
      readonly methods: Readonly<Record<string, string>>;
      readonly gaps: readonly PlaytestBindingGap[];
    }
  | {
      readonly kind: "rejected";
      readonly message: string;
    };

const EXPORT_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const PATH_SEGMENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validReference(value: unknown): boolean {
  if (!isRecord(value) || typeof value.export !== "string") return false;
  if (!EXPORT_NAME_PATTERN.test(value.export)) return false;
  if (value.path === undefined) return true;
  if (typeof value.path !== "string" || value.path.length === 0) return false;
  return value.path
    .split(".")
    .every((segment) => PATH_SEGMENT_PATTERN.test(segment));
}

/**
 * Validate a binding and report every protocol method it cannot supply.
 *
 * An unbindable method is listed rather than defaulted, so a game is told what
 * it still has to write instead of discovering it as an unexplained refusal
 * mid-run.
 */
export function resolvePlaytestAdapterBinding(
  value: unknown
): PlaytestBindingResolution {
  if (!isRecord(value)) {
    return { kind: "rejected", message: "The adapter binding must be an object." };
  }
  if (value.schema !== PLAYTESTS_ADAPTER_BINDING_SCHEMA) {
    return {
      kind: "rejected",
      message: `The adapter binding must declare schema ${PLAYTESTS_ADAPTER_BINDING_SCHEMA}.`
    };
  }
  if (value.schemaVersion !== 1) {
    return { kind: "rejected", message: "Unsupported adapter binding version." };
  }
  if (value.tier !== "declarative" && value.tier !== "generated-scaffold") {
    return {
      kind: "rejected",
      message:
        "The adapter binding must state its onboarding tier as declarative or generated-scaffold."
    };
  }
  if (typeof value.entry !== "string" || value.entry.length === 0) {
    return {
      kind: "rejected",
      message: "The adapter binding must name an entry module."
    };
  }
  if (typeof value.factory !== "string" || !EXPORT_NAME_PATTERN.test(value.factory)) {
    return {
      kind: "rejected",
      message: "The adapter binding must name a factory export."
    };
  }
  if (!isRecord(value.bindings)) {
    return {
      kind: "rejected",
      message: "The adapter binding must declare its protocol bindings."
    };
  }
  if (value.seededRng !== undefined && !validReference(value.seededRng)) {
    return {
      kind: "rejected",
      message: "The seeded RNG binding is malformed."
    };
  }
  // The schemas are declared, never invented here, and each must be a JSON
  // object: AutoDev hashes exactly what the game wrote.
  for (const key of ["observation", "action", "event"]) {
    const schema = isRecord(value.schemas)
      ? value.schemas[key]
      : undefined;
    if (!isRecord(schema)) {
      return {
        kind: "rejected",
        message: `The adapter binding must declare the game's ${key} schema.`
      };
    }
  }
  for (const key of Object.keys(value.bindings)) {
    if (
      !(PLAYTESTS_BINDABLE_METHODS as readonly string[]).includes(key) ||
      !validReference(value.bindings[key])
    ) {
      return {
        kind: "rejected",
        message: `The binding for "${key}" is not a resolvable protocol reference.`
      };
    }
  }
  const gaps: PlaytestBindingGap[] = [];
  for (const method of PLAYTESTS_REQUIRED_BINDINGS) {
    if (value.bindings[method] === undefined) {
      gaps.push({
        kind: "missing-required",
        method,
        message: `The game has no declared ${method} binding; AutoDev will not supply a default for it.`
      });
    }
  }
  const methods: Record<string, string> = {};
  for (const [method, reference] of Object.entries(value.bindings)) {
    if (!isRecord(reference)) continue;
    methods[method] =
      typeof reference.path === "string"
        ? `${reference.export}.${reference.path}`
        : String(reference.export);
  }
  return gaps.length > 0
    ? { kind: "rejected", message: gaps.map((gap) => gap.message).join(" ") }
    : { kind: "resolved", methods, gaps };
}

/**
 * Methods a binding leaves to AutoDev, which it therefore cannot perform.
 *
 * AutoDev-owned methods are excluded: they are always served, so leaving one
 * unbound is not a capability gap and must not be reported as one.
 */
export function unboundPlaytestMethods(
  binding: PlaytestAdapterBinding
): readonly PlaytestBindableMethod[] {
  return PLAYTESTS_BINDABLE_METHODS.filter(
    (method) =>
      binding.bindings[method] === undefined &&
      !PLAYTESTS_ADAPTER_OWNED_METHODS.includes(method)
  );
}