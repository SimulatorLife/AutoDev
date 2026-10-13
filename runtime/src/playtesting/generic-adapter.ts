/**
 * Generic adapter runtime.
 *
 * Binds the game-adapter protocol to a game from its declared bindings, so the
 * game supplies its own functions instead of implementing thirteen protocol
 * methods. Three things this owns that a hand-written adapter got wrong or
 * repeated:
 *
 * - The capability advertisement's schema digests are computed from the game's
 *   own declared schemas rather than written into the file. A hand-maintained
 *   digest silently mismatches when a schema is edited.
 * - An unbound protocol method is refused by name. Answering from a default
 *   would hand the analyst an observation no game produced.
 * - Method dispatch is normalized in one place, so the revision and event
 *   bookkeeping the protocol expects is applied identically for every method.
 */
import {
  PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES,
  PLAYTESTS_ADAPTER_DEFAULT_QUOTAS,
  PLAYTESTS_ADAPTER_METHODS,
  type PlaytestAdapterBinding,
  PLAYTESTS_PROTOCOL_VERSION,
  PLAYTESTS_REQUIRED_BINDINGS,
  type PlaytestBindableMethod,
  type PlaytestCapabilityAdvertisement,
  type PlaytestJsonSchema,
  playtestManifestHash,
  resolvePlaytestAdapterBinding,
  unboundPlaytestMethods
} from "@simulatorlife/autodev-core";

export type GenericAdapterFailureCode =
  | "unresolved-binding"
  | "unbound-method"
  | "entry-error"
  | "factory-error";

export class GenericAdapterError extends Error {
  readonly code: GenericAdapterFailureCode;

  constructor(code: GenericAdapterFailureCode, message: string) {
    super(message);
    this.name = "GenericAdapterError";
    this.code = code;
  }
}

/**
 * The game object the entry factory produced. Its shape is the game's; this
 * runtime only reaches it through declared references.
 */
export type BoundGame = Readonly<Record<string, unknown>>;

/**
 * Injected so the binding resolves inside the integration directory and a test
 * can supply a game without a filesystem.
 */
export type AdapterEntryLoader = (input: {
  readonly entry: string;
  readonly factory: string;
}) => Promise<BoundGame> | BoundGame;

export interface GenericAdapterOptions {
  readonly binding: unknown;
  readonly loadEntry: AdapterEntryLoader;
  readonly engineBuild: string;
  readonly modes: readonly string[];
  readonly scenarioIds: readonly string[];
  /** The game's own declared schemas, not AutoDev's. */
  readonly observationSchema: PlaytestJsonSchema;
  readonly actionSchema: PlaytestJsonSchema;
  readonly eventSchema: PlaytestJsonSchema;
  readonly quotas?: PlaytestCapabilityAdvertisement["quotas"];
  readonly rngVersion?: string | null;
}

/** Protocol method name for a declared binding, e.g. `legalActions` -> `game.legalActions`. */
export function protocolMethodFor(method: PlaytestBindableMethod): string {
  return `game.${method}`;
}

function referencePath(
  reference: { readonly export: string; readonly path?: string }
): readonly string[] {
  return reference.path === undefined
    ? [reference.export]
    : [reference.export, ...reference.path.split(".")];
}

/**
 * The capability advertisement, with every digest derived from the game's own
 * schemas. A game declares schemas; it does not declare their hashes.
 */
export function buildCapabilityAdvertisement(
  options: GenericAdapterOptions,
  bound: PlaytestAdapterBinding
): PlaytestCapabilityAdvertisement {
  const observationSchemaHash = playtestManifestHash(
    options.observationSchema
  );
  const actionSchemaHash = playtestManifestHash(options.actionSchema);
  const eventSchemaHash = playtestManifestHash(options.eventSchema);
  const unbound = unboundPlaytestMethods(bound);
  return {
    protocolVersion: PLAYTESTS_PROTOCOL_VERSION,
    schemaHashAlgorithm: "sha256-canonical-json-v1",
    engineBuild: options.engineBuild,
    modes: options.modes as PlaytestCapabilityAdvertisement["modes"],
    scenarioIds: options.scenarioIds,
    observationSchema: options.observationSchema,
    actionSchema: options.actionSchema,
    eventSchema: options.eventSchema,
    observationSchemaHash,
    actionSchemaHash,
    eventSchemaHash,
    // Only methods the game actually bound are advertised as optional
    // operations. Advertising one it cannot serve is a capability lie the
    // Runtime would discover as a mid-run failure.
    optionalOperations: unbound.map(
      protocolMethodFor
    ) as PlaytestCapabilityAdvertisement["optionalOperations"],
    // The protocol's own defaults, not limits this runtime invented.
    quotas: options.quotas ?? { ...PLAYTESTS_ADAPTER_DEFAULT_QUOTAS },
    deterministic: {
      // Declared, not assumed: an adapter without a seeded-RNG entry point
      // cannot restore engine RNG for a counterfactual, and reporting
      // seededRuns it cannot honour would make a rerun look reproducible.
      seededRuns: bound.seededRng !== undefined,
      rngVersion:
        bound.seededRng === undefined ? null : options.rngVersion ?? null,
      traceReplayable: bound.bindings.replay !== undefined
    }
  };
}

export interface GenericAdapter {
  readonly binding: PlaytestAdapterBinding;
  readonly capabilities: PlaytestCapabilityAdvertisement;
  /** Dispatch one protocol method to the game's bound function. */
  invoke(
    method: PlaytestBindableMethod,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown>;
}

/**
 * Build a bound adapter from its declarations.
 *
 * Refuses an unusable binding before loading anything, so a game with a broken
 * declaration is told which method is missing rather than seeing a transport
 * error from a module that never ran.
 */
export async function createGenericAdapter(
  options: GenericAdapterOptions
): Promise<GenericAdapter> {
  const resolution = resolvePlaytestAdapterBinding(options.binding);
  if (resolution.kind === "rejected") {
    throw new GenericAdapterError(
      "unresolved-binding",
      `The adapter binding is not usable: ${resolution.message}`
    );
  }
  const binding = options.binding as PlaytestAdapterBinding;
  let game: BoundGame;
  try {
    game = await options.loadEntry({
      entry: binding.entry,
      factory: binding.factory
    });
  } catch (error) {
    throw new GenericAdapterError(
      "entry-error",
      `The adapter entry ${binding.entry} could not be loaded: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const resolve = (
    method: PlaytestBindableMethod
  ): ((params: Readonly<Record<string, unknown>>) => unknown) | null => {
    const reference = binding.bindings[method];
    if (reference === undefined) return null;
    let current: unknown = game;
    for (const segment of referencePath(reference)) {
      if (typeof current !== "object" || current === null) return null;
      current = (current as Record<string, unknown>)[segment];
    }
    return typeof current === "function"
      ? (current as (
          params: Readonly<Record<string, unknown>>
        ) => unknown)
      : null;
  };

  // A required binding that resolves to a non-function is a broken declaration,
  // not a missing capability: the reference exists but cannot be called.
  for (const method of PLAYTESTS_REQUIRED_BINDINGS) {
    if (binding.bindings[method] !== undefined && resolve(method) === null) {
      throw new GenericAdapterError(
        "unresolved-binding",
        `The declared ${method} binding does not resolve to a function on the object ${binding.factory} returned.`
      );
    }
  }
  // The seeded-RNG reference is resolved too. Advertising seededRuns while the
  // reference points at nothing would tell the Runtime a rerun is reproducible
  // when engine RNG cannot actually be restored.
  if (binding.seededRng !== undefined) {
    let current: unknown = game;
    for (const segment of referencePath(binding.seededRng)) {
      if (typeof current !== "object" || current === null) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (typeof current !== "function") {
      throw new GenericAdapterError(
        "unresolved-binding",
        "The declared seededRng binding does not resolve to a function on the object the factory returned."
      );
    }
  }

  return {
    binding,
    capabilities: buildCapabilityAdvertisement(options, binding),
    invoke: async (method, params) => {
      const target = resolve(method);
      if (target === null) {
        throw new GenericAdapterError(
          "unbound-method",
          `The game has no usable ${protocolMethodFor(method)} binding; AutoDev will not answer it with a default.`
        );
      }
      try {
        return await target(params);
      } catch (error) {
        if (error instanceof GenericAdapterError) throw error;
        throw new GenericAdapterError(
          "factory-error",
          `The bound ${protocolMethodFor(method)} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  };
}

/** The capability error code used when a game refuses a declared method. */
export const GENERIC_ADAPTER_UNSUPPORTED =
  PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.unsupportedCapability;