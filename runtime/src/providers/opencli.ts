/**
 * `opencli` site process runner, dedicated Chrome for Testing lifecycle, and
 * health/model-discovery daemon used for `github-worker` web automation and
 * Control API browser toggles (`opencli-browser-setting.ts`).
 */

import {
  type ChildProcess,
  type ChildProcessByStdio,
  spawn
} from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
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
import {
  opencliBrowserSettingFile,
  readOpencliDedicatedBrowser
} from "@simulatorlife/autodev-runtime/shared/opencli-browser-setting";
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

import { type ProviderRoute, ROUTES } from "../router/routing.ts";
import {
  OpencliBrowser,
  resolveOpencliBrowserExecutable
} from "./opencli-browser.ts";
import {
  OPENCLI_SITE_SPECS,
  OpencliCommandError,
  parseOpencliOutput
} from "./opencli-turn.ts";

type JsonRecord = Record<string, unknown>;

export const PROVIDER = "opencli";
export const OPENCLI_ROUTER_AUTH_VARIABLE = "CODEX_ROUTER_OPENCLI_API_KEY";
const DEFAULT_PORT = 4004;
const SITE_BUSY = "SITE_BUSY";
const KILL_GRACE_MS = 2000;
const CANCEL_SETTLE_MS = 5000;
const MODEL_LIST_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 60_000;
const SETTING_POLL_MS = 1000;

export interface OpencliRunRequest {
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly onProgress?: (record: Record<string, unknown>) => void;
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

export function opencliSiteSlots(
  tabs: Readonly<Record<OpencliSite, number>>
): string {
  return OPENCLI_SITES.map((site) => `${site}:${tabs[site]}`).join(",");
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
  dedicated: () => boolean,
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
  const quarantined = new Map<OpencliSite, number>();
  const extensionEnv = {
    ...process.env,
    OPENCLI_CDP_ENDPOINT: undefined,
    OPENCLI_SITE_SLOTS: opencliSiteSlots(siteTabs)
  };
  const spawnOpencli = (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    onProgress: OpencliRunRequest["onProgress"]
  ): Promise<JsonRecord[]> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new OpencliCommandError("turn cancelled", "CANCELLED", null));
        return;
      }
      const site = OPENCLI_SITES.includes(args[0] as OpencliSite)
        ? (args[0] as OpencliSite)
        : null;
      const dedicatedEndpoint = env.OPENCLI_CDP_ENDPOINT || null;
      if (
        !dedicatedEndpoint &&
        site !== null &&
        (quarantined.get(site) ?? 0) > 0
      ) {
        reject(
          new OpencliCommandError(
            `a cancelled ${site} command has not exited; its tab remains quarantined`,
            SITE_BUSY,
            null
          )
        );
        return;
      }
      const command = resolveCommand();
      const child = spawnCommand(command.command, [...command.args, ...args], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: { ...env, OPENCLI_PROGRESS_FD: onProgress ? "3" : undefined }
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
      let closed = false;
      let settled = false;
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
        closed = true;
        live.delete(child);
        signal.removeEventListener("abort", onAbort);
        if (killTimer) clearTimeout(killTimer);
        if (settleTimer) clearTimeout(settleTimer);
        if (isQuarantined) {
          if (dedicatedEndpoint) {
            browser.releaseQuarantine(dedicatedEndpoint);
          } else if (site !== null) {
            const remaining = (quarantined.get(site) ?? 1) - 1;
            if (remaining > 0) quarantined.set(site, remaining);
            else quarantined.delete(site);
          }
        }
      };
      const onAbort = (): void => {
        if (closed) return;
        signalChild("SIGTERM");
        killTimer = setTimeout(() => {
          if (!closed) signalChild("SIGKILL");
        }, KILL_GRACE_MS);
        settleTimer = setTimeout(() => {
          if (closed || settled) return;
          if (dedicatedEndpoint) {
            browser.quarantine(dedicatedEndpoint);
            isQuarantined = true;
          } else if (site !== null) {
            quarantined.set(site, (quarantined.get(site) ?? 0) + 1);
            isQuarantined = true;
          }
          settled = true;
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
        if (closed) return;
        cleanup();
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once("close", (code) => {
        if (closed) return;
        cleanup();
        if (settled) return;
        settled = true;
        if (signal.aborted) {
          reject(new OpencliCommandError("turn cancelled", "CANCELLED", code));
          return;
        }
        try {
          resolve(parseOpencliOutput(stdout, code));
        } catch (error) {
          if (error instanceof OpencliCommandError && stderr.trim()) {
            error.message = `${error.message}; stderr: ${stderr.trim().slice(-800)}`;
          }
          reject(error);
        }
      });
    });
  const run: OpencliRunner = ({ args, signal, onProgress }) => {
    const site = args[0] as OpencliSite;
    if (!dedicated() || !OPENCLI_SITES.includes(site)) {
      return spawnOpencli(args, extensionEnv, signal, onProgress);
    }
    return browser.run(site, signal, (endpoint) =>
      spawnOpencli(
        [...args, "--site-session", "ephemeral"],
        {
          ...process.env,
          OPENCLI_CDP_ENDPOINT: endpoint,
          OPENCLI_SITE_SLOTS: undefined
        },
        signal,
        onProgress
      )
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
    const spec = OPENCLI_SITE_SPECS[site];
    const specModels = spec.models;
    const models = Array.isArray(specModels)
      ? specModels
      : typeof specModels === "function"
        ? await specModels((args) =>
            options.run({
              args,
              signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS)
            })
          )
        : [];
    modelLists.set(site, { at: Date.now(), models });
    return models;
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
      const providerParam = url.searchParams.get("provider");
      const providers =
        providerParam &&
        (OPENCLI_PROVIDERS as readonly string[]).includes(providerParam)
          ? [providerParam as OpencliProvider]
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
    DEFAULT_PORT
  );
  const live = new Set<ChildProcess>();
  const siteTabs = routedSiteTabs();
  const settingFile = opencliBrowserSettingFile();
  let dedicated = readOpencliDedicatedBrowser(settingFile);
  const browser = new OpencliBrowser({
    executable: resolveOpencliBrowserExecutable(process.env) ?? "",
    siteTabs
  });
  const runner = processRunner(
    () => resolveOpencliCommand(),
    siteTabs,
    () => dedicated,
    live,
    browser
  );
  const healthServer = createOpencliHealthServer({
    run: runner,
    browserHealth: () =>
      dedicated
        ? { ready: browser.isReady, error: browser.unavailableReason }
        : { ready: true, error: null }
  });
  const server = createServer((request, response) => {
    void healthServer.handle(request, response);
  });
  let shuttingDown = false;
  watchFile(settingFile, { interval: SETTING_POLL_MS }, () => {
    const next = readOpencliDedicatedBrowser(settingFile);
    if (next === dedicated || shuttingDown) return;
    dedicated = next;
    writeErrorLine(
      `opencli browser: ${dedicated ? "dedicated Chrome for Testing" : "the operator's Chrome via the Browser Bridge extension"}`
    );
    void (dedicated ? browser.initialize() : browser.stop());
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      unwatchFile(settingFile);
      for (const child of live) child.kill("SIGTERM");
      if (server.listening) server.close();
      void runner.close().finally(() => process.exit(0));
    });
  }
  void (dedicated ? browser.initialize() : Promise.resolve()).finally(() => {
    if (shuttingDown) return;
    server.listen(port, host, () => {
      writeErrorLine(`opencli service listening at http://${host}:${port}`);
    });
  });
}
