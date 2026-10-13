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
 */
export const PLAYTESTS_REQUIRED_BINDINGS: readonly PlaytestBindableMethod[] = [
  "capabilities",
  "reset",
  "observe",
  "legalActions",
  "step",
  "outcome"
];

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
  readonly bindings: Readonly<Partial<Record<PlaytestBindableMethod, PlaytestBindingReference>>>;
}

export const PLAYTESTS_ADAPTER_BINDING_SCHEMA =
  "autodev-playtest-adapter-binding-v1" as const;

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

/** Methods a binding leaves to AutoDev, which it therefore cannot perform. */
export function unboundPlaytestMethods(
  binding: PlaytestAdapterBinding
): readonly PlaytestBindableMethod[] {
  return PLAYTESTS_BINDABLE_METHODS.filter(
    (method) => binding.bindings[method] === undefined
  );
}