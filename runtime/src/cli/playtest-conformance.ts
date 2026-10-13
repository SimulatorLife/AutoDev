/**
 * `autodev playtest conformance` — prove the game's declarations work.
 *
 * `check` reads files and compares digests, which is the right gate for
 * approval: it answers "is this integration internally consistent". It cannot
 * answer "does this game actually run", because nothing in a binding file
 * proves that a declared `entry` resolves, that the named factory exists, or
 * that the five required methods produce protocol-shaped results.
 *
 * That gap is why a game could pass `check` and fail its first approved batch,
 * with the operator meeting the failure as a container timeout. Conformance
 * loads the game's real entry module and drives one real episode through the
 * real generic adapter and the real Runtime client, so a broken declaration is
 * a named message at onboarding instead of an unexplained run failure.
 *
 * It is read-only with respect to the game: nothing is written, and the episode
 * runs against the game's own code in-process.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  assertPlaytestObservationContract,
  PLAYTESTS_ADAPTER_BINDING_SCHEMA,
  PLAYTESTS_INTEGRATION_DIR,
  type PlaytestAdapterBinding,
  type PlaytestBindableMethod,
  type PlaytestJsonSchema
} from "@simulatorlife/autodev-core";

import { PlaytestAdapterClient } from "../playtesting/adapter-client.ts";
import { startGenericAdapterHost } from "../playtesting/generic-adapter-host.ts";
import { readAdapterContext } from "../playtesting/generic-adapter-main.ts";

/** Bound so a game that never answers cannot hold the command open. */
const CONFORMANCE_DEADLINE_MS = 15_000;

export interface ConformanceFailure {
  /** The protocol method, or `entry`/`factory`/`binding` for a load failure. */
  readonly stage: string;
  readonly message: string;
}

export interface ConformanceReport {
  readonly ok: boolean;
  /** The declared binding that was exercised, for the operator to confirm. */
  readonly tier: PlaytestAdapterBinding["tier"] | null;
  readonly methodsExercised: readonly PlaytestBindableMethod[];
  readonly failures: readonly ConformanceFailure[];
  /** Episode id the game issued, so a run can be matched to this check. */
  readonly episodeId: string | null;
}

function failure(stage: string, error: unknown): ConformanceFailure {
  return {
    stage,
    message: error instanceof Error ? error.message : String(error)
  };
}

/**
 * Read the game's schemas and declared tier.
 *
 * A binding that does not parse is reported here rather than thrown, so the
 * operator gets one message naming the file rather than a stack trace.
 */
function readDeclaredContext(
  integrationDir: string
):
  | Pick<
      ReturnType<typeof readAdapterContext>,
      | "binding"
      | "observationSchema"
      | "actionSchema"
      | "eventSchema"
      | "modes"
      | "scenarioIds"
    >
  | ConformanceFailure {
  try {
    const context = readAdapterContext(integrationDir);
    const binding = context.binding as PlaytestAdapterBinding;
    if (binding.schema !== PLAYTESTS_ADAPTER_BINDING_SCHEMA) {
      return {
        stage: "binding",
        message: `${PLAYTESTS_INTEGRATION_DIR}/playtest.binding.json does not declare the adapter binding schema.`
      };
    }
    return context;
  } catch (error) {
    return failure("binding", error);
  }
}

/**
 * Drive one episode against the game's own code.
 *
 * Every call goes through the production client against the production host, so
 * a method that returns a loosely-shaped result is rejected here exactly as an
 * approved batch would reject it — with the same validator and the same message.
 */
export async function runPlaytestConformance(
  checkoutRoot: string
): Promise<ConformanceReport> {
  const integrationDir = path.resolve(checkoutRoot, PLAYTESTS_INTEGRATION_DIR);
  if (!existsSync(integrationDir)) {
    return {
      ok: false,
      tier: null,
      methodsExercised: [],
      episodeId: null,
      failures: [
        {
          stage: "integration-directory",
          message: `No ${PLAYTESTS_INTEGRATION_DIR}/ directory. Run "autodev playtest init" first.`
        }
      ]
    };
  }

  const declared = readDeclaredContext(integrationDir);
  if ("stage" in declared) {
    return {
      ok: false,
      tier: null,
      methodsExercised: [],
      episodeId: null,
      failures: [declared]
    };
  }

  const binding = declared.binding as PlaytestAdapterBinding;
  const clientToHost = new PassThrough();
  const hostToClient = new PassThrough();
  const methodsExercised: PlaytestBindableMethod[] = [];
  const failures: ConformanceFailure[] = [];
  let episodeId: string | null = null;

  let host: Awaited<ReturnType<typeof startGenericAdapterHost>> | null = null;
  try {
    host = await startGenericAdapterHost({
      binding,
      loadEntry: createConformanceEntryLoader(integrationDir, checkoutRoot),
      engineBuild: "conformance",
      modes: declared.modes as never,
      scenarioIds: declared.scenarioIds,
      observationSchema: declared.observationSchema as PlaytestJsonSchema,
      actionSchema: declared.actionSchema as PlaytestJsonSchema,
      eventSchema: declared.eventSchema as PlaytestJsonSchema,
      input: clientToHost,
      output: hostToClient
    });
  } catch (error) {
    return {
      ok: false,
      tier: binding.tier,
      methodsExercised,
      episodeId: null,
      failures: [failure("entry", error)]
    };
  }

  const client = new PlaytestAdapterClient({
    stdin: clientToHost,
    stdout: hostToClient,
    stderr: new PassThrough(),
    onExit: () => {}
  });
  void host.serve();

  const call = async (
    method: PlaytestBindableMethod,
    params: Readonly<Record<string, unknown>>
  ): Promise<Record<string, unknown> | null> => {
    const result = await client.call(`game.${method}` as never, params);
    if (!result.ok) {
      failures.push({
        stage: method,
        message: `${result.code}: ${result.message}`
      });
      return null;
    }
    methodsExercised.push(method);
    return result.result as Record<string, unknown>;
  };

  try {
    const capabilities = await client.negotiateCapabilities();
    // An advertisement the Runtime could never use would fail the first batch,
    // so it is proven here where the operator can act on it.
    if (capabilities.observationSchemaHash.length !== 64) {
      failures.push({
        stage: "capabilities",
        message: "The capability advertisement carries no usable schema digest."
      });
    }

    const opened = await call("reset", {
      seed: "conformance-seed",
      scenarioId: declared.scenarioIds[0] ?? "default",
      approvedVariantHash: "0".repeat(64)
    });
    episodeId = typeof opened?.episodeId === "string" ? opened.episodeId : null;
    if (opened === null) {
      return finish();
    }
    const revision = typeof opened.revision === "number" ? opened.revision : 0;

    const observed = await call("observe", {
      episodeId,
      expectedRevision: revision
    });

    // The action to take is the game's own: conformance steps through an action
    // it advertised, rather than one AutoDev invented, so a game that only
    // accepts particular actions is exercised as it actually behaves.
    const advertised = await call("legalActions", {
      episodeId,
      expectedRevision: revision
    });
    const actionId =
      advertised === null
        ? null
        : (
            advertised as {
              actions?: readonly { actionId?: unknown }[];
            }
          ).actions?.[0]?.actionId;
    if (typeof actionId !== "string") {
      if (advertised !== null) {
        failures.push({
          stage: "step",
          message:
            "The game advertised no legal actions, so an episode could not advance."
        });
      }
    } else {
      const stepped = await call("step", {
        episodeId,
        actionId,
        expectedRevision: revision
      });
      if (stepped !== null) {
        await call("outcome", {
          episodeId,
          expectedRevision:
            typeof stepped.revision === "number" ? stepped.revision : revision
        });
      }
    }
  } catch (error) {
    failures.push(failure("episode", error));
  } finally {
    client.close();
    host.close();
  }
  return finish();

  function finish(): ConformanceReport {
    return {
      ok: failures.length === 0,
      tier: binding.tier,
      methodsExercised,
      episodeId,
      failures
    };
  }
}

/**
 * Load the game's entry the same way the adapter image does.
 *
 * Kept here rather than imported so `check`/`conformance` never depends on the
 * adapter entrypoint's module-level side effects.
 */
function createConformanceEntryLoader(
  integrationDir: string,
  checkoutRoot: string
): (input: {
  entry: string;
  factory: string;
}) => Promise<Record<string, unknown>> {
  return async ({ entry, factory }) => {
    const root = path.resolve(integrationDir);
    const boundary = path.resolve(checkoutRoot);
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
    const module: unknown = await import(
      /* @vite-ignore */ `file://${resolved}`
    );
    const create = (module as Record<string, unknown>)[factory];
    if (typeof create !== "function") {
      throw new TypeError(
        `The entry module does not export a factory named ${factory}.`
      );
    }
    const game = await (create as () => unknown)();
    if (typeof game !== "object" || game === null) {
      throw new TypeError("The entry factory did not return a game object.");
    }
    return game as Record<string, unknown>;
  };
}

/**
 * Render the report for an operator.
 *
 * A failure names the stage it happened at, because "conformance failed" is the
 * one message that helps nobody.
 */
export function formatConformanceReport(report: ConformanceReport): string {
  if (report.ok) {
    return `playtest conformance passed (${report.tier} tier; exercised ${report.methodsExercised.join(", ")})`;
  }
  const lines = report.failures.map(
    (entry) => `error: ${entry.stage}: ${entry.message}`
  );
  return ["playtest conformance failed", ...lines].join("\n");
}

/** Re-exported so the observation contract assertion stays owned here. */
export { assertPlaytestObservationContract };
