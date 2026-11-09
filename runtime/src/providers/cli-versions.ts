/**
 * The version of the CLI that serves each provider.
 *
 * A provider is served by a CLI, and the CLI's release is the first thing an
 * operator needs when a provider behaves differently than it used to: a
 * release note names a version, and a bug report needs one. The Runtime
 * already knows which CLI serves which provider -- it spawns them -- so the
 * version is read from the same binary the bridge would run, and the number
 * the Console shows is the number in use.
 *
 * The reading is off the request path. A version does not change while a
 * request is in flight, and spawning a process per page view would make the
 * page wait on six CLIs to answer a question about six numbers. The service
 * refreshes in the background and the Control API answers from the snapshot
 * it holds.
 */

import { type ChildProcess, spawn } from "node:child_process";

import type {
  ControlApiProviderCliVersion,
  ControlApiProviderVersionEntry,
  ControlApiProviderVersionsResponse
} from "@simulatorlife/autodev-core";
import {
  findAgyBinary,
  findClaudeBinary,
  findCopilotBinary,
  findMiniMaxBinary,
  findOpencliCommand,
  findCodexBinary
} from "@simulatorlife/autodev-runtime/shared/executables";

import { ROUTING_POLICY } from "../router/routing.ts";

/**
 * How long a CLI gets to answer `--version`.
 *
 * A version print is a start, a read and an exit: the observed commands take
 * well under a second. The bound is generous because it is the *slow* case
 * that matters -- a CLI that has to warm something up before it prints -- and
 * because a version is not worth a stalled page load.
 */
export const CLI_VERSION_TIMEOUT_MS = 5_000;
/** The bound on what a CLI may print before its output is refused. */
const MAX_VERSION_OUTPUT_BYTES = 8 * 1024;
/**
 * How often the versions are read again.
 *
 * A CLI is upgraded by a person, rarely, and the operator finds out from a
 * release note rather than from a poll. Ten minutes is short enough that an
 * upgraded CLI is visible within a working session and long enough that the
 * refresh costs six process starts an hour.
 */
export const CLI_VERSION_REFRESH_INTERVAL_MS = 10 * 60_000;
/**
 * A version, as the CLIs that serve providers print them.
 *
 * The CLIs do not agree on a shape: `claude --version` prints
 * `2.1.280 (Claude Code)`, `codex --version` prints `codex-cli 0.154.0`, and
 * `agy --version` prints `1.5.3`. The first dotted number in the output is
 * the version in every one of them, so the parser reads that rather than
 * demanding one shape and reporting the rest as unreadable.
 */
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/u;

/**
 * How one provider's CLI is run.
 *
 * `command` is the name an operator would type, which is what the Console
 * shows beside the version. `program` and `args` are what is actually
 * executed: opencli is a package dependency rather than a global install, so
 * it runs as the current Node with the package's entry point.
 */
export interface ProviderCliCommand {
  readonly command: string;
  readonly program: string;
  readonly args: readonly string[];
}

/** The CLIs that serve providers, and how each one is found. */
interface ProviderCliDefinition {
  /** The name an operator would type. */
  readonly command: string;
  /** The provider's name in the product. */
  readonly label: string;
  /** Where the CLI is, or null when it is not installed. */
  readonly locate: (env: NodeJS.ProcessEnv) => ProviderCliCommand | null;
}

function located(
  command: string,
  program: string,
  args: readonly string[] = []
): ProviderCliCommand {
  return { command, program, args };
}

/**
 * The Codex CLI, which is resolved by the shared lookup the MCP launcher
 * uses. The lookup fails loudly when the CLI is missing, so the failure is
 * caught here: a missing CLI is a fact to report, not an error to throw
 * while the page is being built.
 */
function locateCodex(env: NodeJS.ProcessEnv): ProviderCliCommand | null {
  const binary = findCodexBinary(env);
  return binary ? located("codex", binary) : null;
}

const PROVIDER_CLIS: Readonly<Record<string, ProviderCliDefinition>> = {
  claude: {
    command: "claude",
    label: "Claude Code",
    locate: (env) => {
      const binary = findClaudeBinary(env);
      return binary ? located("claude", binary) : null;
    }
  },
  codex: {
    command: "codex",
    label: "Codex",
    locate: locateCodex
  },
  antigravity: {
    command: "agy",
    label: "Antigravity",
    locate: (env) => {
      const binary = findAgyBinary(env);
      return binary ? located("agy", binary) : null;
    }
  },
  minimax: {
    command: "mmx",
    label: "MiniMax",
    locate: (env) => {
      const binary = findMiniMaxBinary(env);
      return binary ? located("mmx", binary) : null;
    }
  },
  copilot: {
    command: "copilot",
    label: "Copilot",
    locate: (env) => {
      const binary = findCopilotBinary(env);
      return binary ? located("copilot", binary) : null;
    }
  },
  "opencli-chatgpt": {
    command: "opencli",
    label: "opencli",
    locate: locateOpencli
  },
  "opencli-gemini": {
    command: "opencli",
    label: "opencli",
    locate: locateOpencli
  }
};

/**
 * opencli is a package dependency rather than a global install, so it runs
 * as the current Node with the package's entry point. The version it prints
 * is the version the lockfile pins, which is the version the bridge talks to
 * its daemon with.
 */
function locateOpencli(env: NodeJS.ProcessEnv): ProviderCliCommand | null {
  const command = findOpencliCommand(env);
  if (!command) return null;
  return located("opencli", command.command, command.args);
}

/**
 * The name of the CLI that serves a provider, or null when the provider has
 * no CLI.
 *
 * The name is known whether or not the CLI is installed: an operator asking
 * "which CLI serves this provider" is answered by the name, and a provider
 * whose CLI is missing is still served by that CLI in every sense but the
 * one where it is on this machine.
 */
export function providerCliName(provider: string): string | null {
  return PROVIDER_CLIS[provider]?.command ?? null;
}

/**
 * The CLI a provider is served by, or null when the provider has no CLI or
 * the CLI is not installed.
 */
export function providerCliCommand(
  provider: string,
  env: NodeJS.ProcessEnv = process.env
): ProviderCliCommand | null {
  return PROVIDER_CLIS[provider]?.locate(env) ?? null;
}

/**
 * The version in a CLI's output, or null when the output carries none.
 *
 * The first dotted number is the version in every CLI that serves a
 * provider, and taking the first one matters: `agy --version` prints only a
 * number, while `claude --version` prints the number and then the product
 * name in parentheses.
 */
export function parseCliVersion(output: string): string | null {
  const match = VERSION_PATTERN.exec(output);
  return match ? match[0] : null;
}

/** The outcome of reading one CLI's version. */
export type CliVersionCapture =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string };

export interface CliVersionDeps {
  readonly spawnProcess: typeof spawn;
}

/**
 * Read one CLI's version.
 *
 * The read is bounded twice over: the CLI has a deadline, and its output has
 * a size bound. A CLI that hangs on `--version` would otherwise leave the
 * refresh waiting forever, and one that prints without end would fill the
 * Runtime's memory with a version string.
 */
export function captureCliVersion(
  command: ProviderCliCommand,
  deps: CliVersionDeps,
  timeoutMs: number = CLI_VERSION_TIMEOUT_MS
): Promise<CliVersionCapture> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = deps.spawnProcess(command.program, [...command.args, "--version"], {
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      resolve({
        ok: false,
        reason: `The ${command.command} CLI could not be started.`
      });
      return;
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const finish = (capture: CliVersionCapture): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(capture);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 250);
      forceKill.unref();
      finish({
        ok: false,
        reason: `Reading the ${command.command} CLI's version timed out.`
      });
    }, timeoutMs);
    timer.unref();
    const collect = (chunk: Buffer): void => {
      byteLength += chunk.length;
      if (byteLength > MAX_VERSION_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish({
          ok: false,
          reason: `The ${command.command} CLI's version output exceeded the size bound.`
        });
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect);
    // Some CLIs print their version on stderr. Reading it costs nothing and
    // saves the CLI whose version would otherwise be reported as unreadable.
    child.stderr?.on("data", collect);
    child.once("error", () => {
      finish({
        ok: false,
        reason: `The ${command.command} CLI could not be started.`
      });
    });
    child.once("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      const version = parseCliVersion(output);
      if (version) {
        finish({ ok: true, version });
        return;
      }
      finish({
        ok: false,
        reason:
          code === 0
            ? `The ${command.command} CLI did not report a version.`
            : `The ${command.command} CLI exited with status ${String(code)} without reporting a version.`
      });
    });
  });
}

export interface ProviderCliVersionOptions {
  readonly providerIds?: (() => readonly string[]) | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
  readonly refreshIntervalMs?: number | undefined;
  readonly capture?:
    | ((command: ProviderCliCommand) => Promise<CliVersionCapture>)
    | undefined;
  /**
   * Where each provider's CLI is.
   *
   * The default is the shared lookup the bridges use. It is injectable so a
   * test can say which CLI a provider has without installing one: the suite
   * runs on machines that carry different CLIs, and a test that depended on
   * what happened to be installed would fail for a reason that has nothing
   * to do with the code under test.
   */
  readonly locate?:
    | ((provider: string, env: NodeJS.ProcessEnv) => ProviderCliCommand | null)
    | undefined;
  readonly spawnProcess?: typeof spawn | undefined;
}

/**
 * The versions this machine has, and the reasons it does not have them.
 *
 * The snapshot is what the Control API answers from. Every provider gets an
 * entry, including the ones with no CLI and the ones whose CLI is missing:
 * "this provider is served by a CLI that is not installed" is an answer, and
 * leaving the provider out would make the page say nothing where it could
 * say that.
 */
export class ProviderCliVersionService {
  private readonly providerIds: () => readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly refreshIntervalMs: number;
  private readonly capture: (command: ProviderCliCommand) => Promise<CliVersionCapture>;
  private readonly locate: (
    provider: string,
    env: NodeJS.ProcessEnv
  ) => ProviderCliCommand | null;
  private readonly states = new Map<string, ControlApiProviderCliVersion>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(options: ProviderCliVersionOptions = {}) {
    this.providerIds =
      options.providerIds ?? (() => ROUTING_POLICY.providerIds());
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? CLI_VERSION_REFRESH_INTERVAL_MS;
    const spawnProcess = options.spawnProcess ?? spawn;
    this.capture =
      options.capture ??
      ((command) => captureCliVersion(command, { spawnProcess }));
    this.locate =
      options.locate ??
      ((provider, env) => providerCliCommand(provider, env));
    for (const provider of this.providerIds()) {
      this.states.set(provider, {
        status: "unavailable",
        kind: "not-readable",
        command: providerCliName(provider),
        reason: "The CLI version has not been read yet.",
        lastAttemptAt: null
      });
    }
  }

  /** The versions as the Control API reports them. */
  snapshot(): ControlApiProviderVersionsResponse {
    return {
      schema: "autodev-control-provider-versions-v1",
      source: "runtime-provider-cli-versions",
      providers: [...this.providerIds()]
        .sort(PROVIDER_VERSION_COLLATOR.compare)
        .map((provider) => ({
          provider,
          cli:
            this.states.get(provider) ??
            ({
              status: "unavailable",
              kind: "not-readable",
              command: providerCliName(provider),
              reason: "The CLI version has not been read yet.",
              lastAttemptAt: null
            } satisfies ControlApiProviderCliVersion)
        }))
    };
  }

  start(): void {
    if (this.stopped || this.refreshTimer !== null) return;
    void this.refresh();
    this.refreshTimer = setInterval(
      () => void this.refresh(),
      this.refreshIntervalMs
    );
    this.refreshTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Read every provider's CLI version.
   *
   * One refresh at a time: a second refresh arriving while the first is
   * still waiting on a slow CLI would read the same versions twice and race
   * the first one's results into the snapshot.
   */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.readAll().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async readAll(): Promise<void> {
    await Promise.all(
      this.providerIds().map(async (provider) => {
        const command = this.locate(provider, this.env);
        const attemptedAt = this.now().toISOString();
        if (!command) {
          this.states.set(provider, {
            status: "unavailable",
            kind: "not-installed",
            command: providerCliName(provider),
            reason: this.notInstalledReason(provider),
            lastAttemptAt: attemptedAt
          });
          return;
        }
        const capture = await this.capture(command);
        this.states.set(
          provider,
          capture.ok
            ? {
                status: "observed",
                command: command.command,
                version: capture.version,
                observedAt: attemptedAt
              }
            : {
                status: "unavailable",
                kind: "not-readable",
                command: command.command,
                reason: capture.reason,
                lastAttemptAt: attemptedAt
              }
        );
      })
    );
  }

  private notInstalledReason(provider: string): string {
    const definition = PROVIDER_CLIS[provider];
    if (!definition) {
      return "This provider is not served by a local CLI.";
    }
    return `The ${definition.label} CLI (${definition.command}) is not installed.`;
  }
}

const PROVIDER_VERSION_COLLATOR = new Intl.Collator();

export function createProviderCliVersionService(
  options: ProviderCliVersionOptions = {}
): ProviderCliVersionService {
  return new ProviderCliVersionService(options);
}
