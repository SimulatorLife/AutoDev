/**
`opencli` site process runner, dedicated Chrome for Testing lifecycle, and
health/model-discovery daemon used for site-backed role turns and model
discovery.
*/

import {
  type ChildProcess,
  type ChildProcessByStdio,
  spawn
} from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import type { Readable } from "node:stream";

import { isRecord } from "@simulatorlife/autodev-core";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import {
  type OpencliCommand,
  resolveOpencliCommand
} from "@simulatorlife/autodev-runtime/shared/executables";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { sendJson } from "@simulatorlife/autodev-runtime/shared/provider-http";
import {
  OPENCLI_PROVIDER_SITES,
  OPENCLI_PROVIDERS,
  OPENCLI_SITES,
  opencliModelId,
  type OpencliProvider,
  type OpencliSite
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

import { isLoopbackAddress, routerAuthorizationValid } from "../router/auth.ts";
import {
  type ProviderRoute,
  ROUTES,
  ROUTING_POLICY
} from "../router/routing.ts";
import {
  hasRoleContract,
  providerContract
} from "../shared/execution-contract.ts";
import {
  OpencliBrowser,
  OpencliSitePageNotOpenError,
  resolveOpencliBrowserExecutable
} from "./opencli-browser.ts";
import {
  executeOpencliRoleTurn,
  OPENCLI_DEFAULT_PORT,
  OPENCLI_ROLE_TURN_PATH,
  OPENCLI_ROUTER_AUTH_VARIABLE,
  opencliRoleTurnSchema
} from "./opencli-role.ts";
import {
  OPENCLI_SITE_SPECS,
  OpencliCommandError,
  opencliCommandRequiresForeground,
  parseOpencliOutput
} from "./opencli-turn.ts";

type JsonRecord = Record<string, unknown>;

export const PROVIDER = "opencli";
const MAX_ROLE_TURN_BYTES = 512 * 1024;
const KILL_GRACE_MS = 2000;
const CANCEL_SETTLE_MS = 5000;
const MODEL_LIST_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 60_000;

const SAFE_CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "CODEX_HOME",
  "AUTODEV_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "OPENCLI_GEMINI_ACCOUNT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "FORCE_COLOR"
] as const;

function sanitizeOpencliChildEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

export interface OpencliRunRequest {
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly onProgress?: (record: Record<string, unknown>) => void;
  /**
  Run only on a site page that is already open: never start the dedicated
  browser or open a page. Background probes set it, and get
  `OpencliSitePageNotOpenError` when no such page exists.
  */
  readonly existingPageOnly?: boolean;
}

export type OpencliRunner = (
  request: OpencliRunRequest
) => Promise<Record<string, unknown>[]>;

function progressRecord(line: string): JsonRecord | null {
  try {
    const record: unknown = JSON.parse(line);
    return isRecord(record) ? record : null;
  } catch {
    return null;
  }
}

export function routedSiteTabs(
  routes: readonly Pick<
    ProviderRoute,
    "provider" | "maxConcurrentRequests"
  >[] = ROUTES
): Record<OpencliSite, number> {
  const tabs = Object.fromEntries(
    OPENCLI_SITES.map((site) => [site, 1])
  ) as Record<OpencliSite, number>;
  for (const provider of OPENCLI_PROVIDERS) {
    const limit = routes.find(
      (route) => route.provider === provider
    )?.maxConcurrentRequests;
    if (limit !== undefined) tabs[OPENCLI_PROVIDER_SITES[provider]] = limit;
  }
  return tabs;
}

export function processRunner(
  resolveCommand: () => OpencliCommand,
  siteTabs: Readonly<Record<OpencliSite, number>>,
  live: Set<ChildProcess> = new Set(),
  browser = new OpencliBrowser({
    executable: resolveOpencliBrowserExecutable(process.env) ?? "",
    siteTabs
  }),
  spawnCommand: typeof spawn = spawn
): OpencliRunner & {
  readonly browser: OpencliBrowser;
  close(): Promise<void>;
} {
  const childEnvironment = sanitizeOpencliChildEnvironment(process.env);
  const spawnOpencli = (
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    onProgress: OpencliRunRequest["onProgress"]
  ): Promise<JsonRecord[]> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new OpencliCommandError("turn cancelled", "CANCELLED", null));
        return;
      }
      const dedicatedEndpoint = environment.OPENCLI_CDP_ENDPOINT || null;
      const command = resolveCommand();
      const child = spawnCommand(command.command, [...command.args, ...arguments_], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: { ...environment, OPENCLI_PROGRESS_FD: onProgress ? "3" : undefined }
      }) as ChildProcessByStdio<null, Readable, Readable>;
      live.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      const progress = child.stdio[3] as Readable | null | undefined;
      if (onProgress && progress) {
        progress.setEncoding("utf8");
        let pending = "";
        progress.on("data", (chunk: string) => {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (signal.aborted) return;
            const record = progressRecord(line);
            if (record) onProgress(record);
          }
        });
      }
      let isClosed = false;
      let isSettled = false;
      let isQuarantined = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      const signalChild = (name: NodeJS.Signals): void => {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, name);
            return;
          } catch {
            // Child process group already exited.
          }
        }
        try {
          child.kill(name);
        } catch {
          // Child already exited.
        }
      };
      const cleanup = (): void => {
        isClosed = true;
        live.delete(child);
        signal.removeEventListener("abort", onAbort);
        if (killTimer) clearTimeout(killTimer);
        if (settleTimer) clearTimeout(settleTimer);
        if (isQuarantined && dedicatedEndpoint) {
          browser.releaseQuarantine(dedicatedEndpoint);
        }
      };
      const onAbort = (): void => {
        if (isClosed) return;
        signalChild("SIGTERM");
        killTimer = setTimeout(() => {
          if (!isClosed) signalChild("SIGKILL");
        }, KILL_GRACE_MS);
        settleTimer = setTimeout(() => {
          if (isClosed || isSettled) return;
          if (dedicatedEndpoint) {
            browser.quarantine(dedicatedEndpoint);
            isQuarantined = true;
          }
          isSettled = true;
          reject(
            new OpencliCommandError(
              "turn cancelled: opencli did not exit after SIGKILL",
              "CANCELLED",
              null
            )
          );
        }, CANCEL_SETTLE_MS);
        killTimer.unref?.();
        settleTimer.unref?.();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => {
        if (isClosed) return;
        cleanup();
        if (!isSettled) {
          isSettled = true;
          const reason =
            (error as NodeJS.ErrnoException).code ?? "unknown reason";
          reject(
            new OpencliCommandError(
              `OpenCLI could not start process: ${reason}`,
              "COMMAND_EXEC",
              null
            )
          );
        }
      });
      child.once("close", (code, terminationSignal) => {
        if (isClosed) return;
        cleanup();
        if (isSettled) return;
        isSettled = true;
        if (signal.aborted) {
          reject(new OpencliCommandError("turn cancelled", "CANCELLED", code));
          return;
        }
        try {
          if (code === null) {
            throw new OpencliCommandError(
              `OpenCLI process terminated: ${terminationSignal ?? "unknown reason"}`,
              "COMMAND_EXEC",
              null
            );
          }
          const rows = parseOpencliOutput(stdout, code);
          if (code !== 0) {
            throw new OpencliCommandError(
              `OpenCLI exited with code ${code}`,
              "COMMAND_EXEC",
              code
            );
          }
          resolve(rows);
        } catch (error) {
          if (error instanceof OpencliCommandError && stderr.trim()) {
            error.message = `${error.message}; stderr: ${stderr.trim().slice(-800)}`;
          }
          reject(error);
        }
      });
    });
  const run: OpencliRunner = ({ args, signal, onProgress, existingPageOnly }) => {
    const site = args[0] as OpencliSite;
    if (!OPENCLI_SITES.includes(site)) {
      return spawnOpencli(args, childEnvironment, signal, onProgress);
    }
    return browser.run(
      site,
      signal,
      (endpoint, releaseForeground) =>
        spawnOpencli(
          [...args, "--site-session", "ephemeral"],
          {
            ...childEnvironment,
            OPENCLI_CDP_ENDPOINT: endpoint,
            OPENCLI_SITE_SLOTS: undefined
          },
          signal,
          (record) => {
            if (
              record.phase === "submitted" ||
              typeof record.text === "string"
            ) {
              releaseForeground();
            }
            onProgress?.(record);
          }
        ),
      {
        // Only the operations that open a menu with a native click need the
        // browser's foreground; the rest run without it and stay concurrent.
        requiresVisiblePage: opencliCommandRequiresForeground(args),
        shouldOpenPage: existingPageOnly !== true
      }
    );
  };
  return Object.assign(run, {
    browser,
    close: async () => {
      try {
        for (const child of live) {
          if (process.platform !== "win32" && child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
              continue;
            } catch {
              // Child process group already exited.
            }
          }
          try {
            child.kill("SIGKILL");
          } catch {
            // Child already exited.
          }
        }
      } finally {
        await browser.close();
      }
    }
  });
}

export interface OpencliHealthServerOptions {
  readonly run: OpencliRunner;
  /**
  Trusted Runtime-to-browser-service credential; absent disables turns.
  */
  readonly roleTurnToken?: string;
  readonly browserHealth?: () => {
    readonly ready: boolean;
    readonly error: string | null;
  };
}

export function createOpencliHealthServer(
  options: OpencliHealthServerOptions
): {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
} {
  const modelLists = new Map<
    OpencliSite,
    { at: number; models: readonly string[] }
  >();

  async function discoverSiteModels(
    site: OpencliSite
  ): Promise<readonly string[]> {
    const cached = modelLists.get(site);
    if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) {
      return cached.models;
    }
    const specModels = OPENCLI_SITE_SPECS[site].models;
    if (typeof specModels !== "function") return specModels;
    let models: readonly string[];
    try {
      // Discovery is a background probe: it reads a site page only when a
      // turn already opened one, and never opens a browser window itself.
      models = await specModels((arguments_) =>
        options.run({
          args: arguments_,
          signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
          existingPageOnly: true
        })
      );
    } catch (error) {
      if (error instanceof OpencliSitePageNotOpenError) {
        return cached?.models ?? [];
      }
      throw error;
    }
    modelLists.set(site, { at: Date.now(), models });
    return models;
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === OPENCLI_ROLE_TURN_PATH && request.method === "POST") {
      const fail = (
        status: number,
        message: string,
        code: string,
        exitCode: number | null = null
      ): void => {
        if (!response.destroyed) {
          sendJson(response, status, {
            ok: false,
            error: { message, code, exitCode }
          });
        }
      };
      if (
        !options.roleTurnToken ||
        !isLoopbackAddress(request.socket.remoteAddress) ||
        !routerAuthorizationValid(request, options.roleTurnToken)
      ) {
        fail(401, "OpenCLI role turn is not authorized.", "AUTH_REQUIRED");
        return;
      }
      let body: unknown;
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_ROLE_TURN_BYTES)
            throw new Error("body exceeds limit");
          chunks.push(buffer);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        fail(400, "Invalid OpenCLI role turn body.", "INVALID_OUTPUT");
        return;
      }
      const parsed = opencliRoleTurnSchema.safeParse(body);
      if (!parsed.success) {
        fail(400, "Invalid OpenCLI role turn body.", "INVALID_OUTPUT");
        return;
      }
      const task = parsed.data;
      const ingress = providerContract(task.provider).mcpIngress;
      if (
        !hasRoleContract(task.role) ||
        !ROUTING_POLICY.providerReachesRoleMcp(task.provider, task.role) ||
        (ingress === "gateway" && !task.mcpApp) ||
        (ingress !== "gateway" && task.mcpApp !== null)
      ) {
        fail(
          403,
          "OpenCLI transport cannot serve this role surface.",
          "AUTH_REQUIRED"
        );
        return;
      }
      const disconnected = new AbortController();
      const onClose = (): void => {
        if (!response.writableEnded) disconnected.abort();
      };
      response.once("close", onClose);
      try {
        const signal = AbortSignal.any([
          disconnected.signal,
          AbortSignal.timeout(task.timeoutSeconds * 1000)
        ]);
        const result = await executeOpencliRoleTurn(task, options.run, signal);
        if (!response.destroyed) sendJson(response, 200, { ok: true, result });
      } catch (error) {
        if (error instanceof OpencliCommandError) {
          fail(502, error.message, error.code, error.exitCode);
        } else {
          // Never expose the complete command (which contains the prompt).
          fail(
            502,
            "OpenCLI browser service could not execute the turn; inspect service health.",
            "COMMAND_EXEC"
          );
        }
      } finally {
        response.off("close", onClose);
      }
      return;
    }
    if (
      (url.pathname === "/health" || url.pathname === "/health/liveliness") &&
      request.method === "GET"
    ) {
      const health = options.browserHealth?.() ?? { ready: true, error: null };
      if (!health.ready) {
        sendJson(response, 503, {
          status: "unhealthy",
          provider: PROVIDER,
          error: health.error ?? "opencli browser unavailable"
        });
        return;
      }
      sendJson(response, 200, { status: "ok", provider: PROVIDER });
      return;
    }
    if (url.pathname === "/v1/models" && request.method === "GET") {
      const providerParameter = url.searchParams.get("provider");
      const providers =
        providerParameter &&
        (OPENCLI_PROVIDERS as readonly string[]).includes(providerParameter)
          ? [providerParameter as OpencliProvider]
          : OPENCLI_PROVIDERS;
      const data: { id: string; object: "model"; owned_by: OpencliProvider }[] =
        [];
      for (const provider of providers) {
        const site = OPENCLI_PROVIDER_SITES[provider];
        try {
          const models = await discoverSiteModels(site);
          for (const model of models) {
            data.push({
              id: opencliModelId(provider, model),
              object: "model",
              owned_by: provider
            });
          }
        } catch {
          // Leave unreachable site empty in discovery response.
        }
      }
      sendJson(response, 200, { object: "list", data });
      return;
    }
    sendJson(response, 404, {
      error: { message: "not found", type: "invalid_request_error" }
    });
  }

  return { handle };
}

const IS_MAIN = isEntryPoint(import.meta.url);

if (IS_MAIN) {
  const host = process.env.OPENCLI_PROXY_HOST?.trim() || "127.0.0.1";
  const port = parseNonNegativeInteger(
    process.env.OPENCLI_PROXY_PORT,
    OPENCLI_DEFAULT_PORT
  );
  const live = new Set<ChildProcess>();
  const siteTabs = routedSiteTabs();
  const browser = new OpencliBrowser({
    executable: resolveOpencliBrowserExecutable(process.env) ?? "",
    siteTabs
  });
  const runner = processRunner(
    () => resolveOpencliCommand(),
    siteTabs,
    live,
    browser
  );
  const roleTurnToken = process.env[OPENCLI_ROUTER_AUTH_VARIABLE]?.trim();
  const healthServer = createOpencliHealthServer({
    run: runner,
    ...(roleTurnToken && { roleTurnToken }),
    browserHealth: () => {
      const error = browser.unavailableReason;
      return { ready: error === null, error };
    }
  });
  const server = createServer((request, response) => {
    void healthServer.handle(request, response);
  });
  let isShuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      for (const child of live) child.kill("SIGTERM");
      if (server.listening) server.close();
      void runner.close().finally(() => process.exit(0));
    });
  }
  // The browser starts on the first turn that needs a site page, not here:
  // a service (re)start opens no window.
  server.listen(port, host, () => {
    writeErrorLine(`opencli service listening at http://${host}:${port}`);
  });
}
