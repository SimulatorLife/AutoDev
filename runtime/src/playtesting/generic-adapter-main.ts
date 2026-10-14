/**
 * AutoDev's adapter entrypoint.
 *
 * This is the process AutoDev's pinned adapter image runs. It reads the game's
 * binding from the approved integration directory, resolves the game's entry
 * module, and serves the game-adapter protocol on stdio. The game supplies
 * declarations and an entry module; the protocol is AutoDev's.
 *
 * The integration directory is read from the command line rather than discovered
 * from the process working directory: the sandbox mounts the approved checkout
 * read-only at a known path, and resolving against that path is what keeps the
 * binding inside the approved tree.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertPlaytestObservationContract,
  type PlaytestJsonSchema,
  PLAYTESTS_ADAPTER_BINDING_SCHEMA,
  PLAYTESTS_ADAPTER_CONTAINER_WORKSPACE,
  PLAYTESTS_INTEGRATION_DIR
} from "@simulatorlife/autodev-core";

import {
  type GenericAdapterHostOptions,
  startGenericAdapterHost
} from "./generic-adapter-host.ts";

/** Bounded so a hostile or corrupt file cannot be read into memory whole. */
const MAX_BINDING_BYTES = 256 * 1024;

export interface EntryContext {
  readonly binding: unknown;
  readonly engineBuild: string;
  readonly modes: readonly string[];
  readonly scenarioIds: readonly string[];
  readonly observationSchema: PlaytestJsonSchema;
  readonly actionSchema: PlaytestJsonSchema;
  readonly eventSchema: PlaytestJsonSchema;
}

/**
 * Resolve everything the host needs from the integration directory.
 *
 * The schemas are read from the game alongside the binding: a game declares
 * them, and AutoDev derives their digests. They are not invented here.
 */
export function readAdapterContext(integrationDir: string): EntryContext {
  const bindingPath = path.join(integrationDir, "playtest.binding.json");
  const raw = readFileSync(bindingPath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_BINDING_BYTES) {
    throw new TypeError("The adapter binding exceeds the supported size.");
  }
  const binding: unknown = JSON.parse(raw);
  if (
    typeof binding !== "object" ||
    binding === null ||
    (binding as { schema?: unknown }).schema !==
      PLAYTESTS_ADAPTER_BINDING_SCHEMA
  ) {
    throw new TypeError(
      `The adapter binding must declare schema ${PLAYTESTS_ADAPTER_BINDING_SCHEMA}.`
    );
  }
  // The observation contract still governs what a player can see; the adapter
  // schemas live in the binding, because they describe the protocol surface
  // rather than the observation contract.
  const observation = JSON.parse(
    readFileSync(path.join(integrationDir, "playtest.observation.json"), "utf8")
  );
  assertPlaytestObservationContract(observation);
  const record = (binding as { schemas: Readonly<Record<string, unknown>> })
    .schemas;
  const configPath = path.join(integrationDir, "playtest.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    readonly modes?: readonly string[];
    readonly scenarios?: readonly string[];
  };
  return {
    binding,
    engineBuild: process.env.AUTODEV_PLAYTEST_ENGINE_BUILD ?? "unpinned",
    modes: config.modes ?? [],
    scenarioIds: config.scenarios ?? [],
    observationSchema: record.observation as PlaytestJsonSchema,
    actionSchema: record.action as PlaytestJsonSchema,
    eventSchema: record.event as PlaytestJsonSchema
  };
}

/**
 * Import the game's entry module and call its factory.
 *
 * The module is resolved inside the approved checkout and loaded by URL, so the
 * sandbox's read-only checkout mount is the boundary — not the integration
 * directory. A game's code lives in its own source tree, and a binding that
 * could only name a module beside the binding file would force every game to
 * keep a copy of its entry point inside `.autodev/`.
 */
export function createEntryLoader(
  integrationDir: string,
  checkoutRoot: string = PLAYTESTS_ADAPTER_CHECKOUT_ROOT
): GenericAdapterHostOptions["loadEntry"] {
  const root = path.resolve(integrationDir);
  const boundary = path.resolve(checkoutRoot);
  return async ({ entry, factory }) => {
    // A relative entry is declared against the integration directory, so a
    // binding that says `adapter.js` keeps working. An absolute entry is
    // already stated in container terms and is taken as-is, then held to the
    // same containment check.
    const resolved = path.isAbsolute(entry)
      ? path.normalize(entry)
      : path.resolve(root, entry);
    const relative = path.relative(boundary, resolved);
    if (
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new TypeError(
        "The declared entry module must resolve inside the approved checkout."
      );
    }
    const module: unknown = await import(pathToFileURL(resolved).href);
    if (typeof module !== "object" || module === null) {
      throw new TypeError("The entry module did not export an object.");
    }
    const create = (module as Record<string, unknown>)[factory];
    if (typeof create !== "function") {
      throw new TypeError(
        `The entry module does not export a factory named ${factory}.`
      );
    }
    const game: unknown = await create();
    if (typeof game !== "object" || game === null) {
      throw new TypeError("The entry factory did not return a game object.");
    }
    return game as Record<string, unknown>;
  };
}

/**
 * The container path the sandbox mounts the approved checkout at.
 *
 * The adapter resolves its integration directory against this, not against the
 * process working directory: the sandbox sets the working directory to the
 * *game's* approved directory, which is frequently not the checkout root, so a
 * cwd-relative resolve would miss a binding that is present.
 */
export const PLAYTESTS_ADAPTER_CHECKOUT_ROOT =
  PLAYTESTS_ADAPTER_CONTAINER_WORKSPACE;

/**
 * Overrides the checkout root. The sandbox mounts the checkout at the fixed
 * container path above; this lets the same entrypoint run against a checkout
 * somewhere else, which is how the episode test drives it without Docker.
 */
export const PLAYTESTS_ADAPTER_CHECKOUT_ROOT_ENV =
  "AUTODEV_ADAPTER_CHECKOUT_ROOT";

/**
 * Parse `--integration-dir <dir>`, defaulting to `.autodev` in the checkout.
 *
 * Resolved against the checkout root, which the sandbox mounts read-only at a
 * fixed path. Resolving against the process working directory instead would
 * look for the binding under the *game's* working directory, so a game approved
 * with a subdirectory working directory would not find its own integration
 * directory — and would report a missing binding for a file that is present.
 */
export function integrationDirFrom(
  argv: readonly string[],
  checkoutRoot: string = PLAYTESTS_ADAPTER_CHECKOUT_ROOT
): string {
  const index = argv.indexOf("--integration-dir");
  const declared =
    index !== -1 && index + 1 < argv.length ? argv[index + 1]! : null;
  return path.resolve(checkoutRoot, declared ?? PLAYTESTS_INTEGRATION_DIR);
}

/** Serve the protocol on stdio until the Runtime closes the stream. */
export async function main(argv: readonly string[]): Promise<void> {
  const checkoutRoot =
    process.env[PLAYTESTS_ADAPTER_CHECKOUT_ROOT_ENV] ??
    PLAYTESTS_ADAPTER_CHECKOUT_ROOT;
  const integrationDir = integrationDirFrom(argv, checkoutRoot);
  const context = readAdapterContext(integrationDir);
  const host = await startGenericAdapterHost({
    ...context,
    loadEntry: createEntryLoader(integrationDir, checkoutRoot),
    input: process.stdin,
    output: process.stdout
  });
  try {
    await host.serve();
  } finally {
    await host.close();
  }
}

// The adapter image runs this file as its entrypoint. Without this block the
// process would import the module, export `main`, and exit — the Runtime would
// wait on a stdout that never opens rather than seeing an adapter failure.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `autodev-playtest-adapter: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
