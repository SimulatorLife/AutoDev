import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import path from "node:path";

import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

export const ROUTER_AUTH_VARIABLE = "CODEX_ROUTER_AUTH_TOKEN";
/**
 * The private Router-to-bridge credentials, one per bridge that authenticates
 * the router. Each is loaded by both the router's and that bridge's launcher,
 * and never forwarded into the provider process the bridge runs.
 */
export const BRIDGE_ROUTER_AUTH_VARIABLES = {
  Copilot: "CODEX_ROUTER_COPILOT_API_KEY",
  opencli: "CODEX_ROUTER_OPENCLI_API_KEY"
} as const;

function existingToken(filePath: string, variable: string): string | null {
  if (!existsSync(filePath)) return null;
  const matches = readFileSync(filePath, "utf8").match(
    new RegExp(String.raw`^${variable}=([^\n]*)$`, "gmu")
  );
  const value = matches?.at(-1)?.slice(`${variable}=`.length).trim() ?? "";
  return value || null;
}

function appendToken(filePath: string, variable: string, token: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (existsSync(filePath)) {
    const contents = readFileSync(filePath, "utf8");
    if (contents.length > 0 && !contents.endsWith("\n"))
      appendFileSync(filePath, "\n");
  }
  appendFileSync(filePath, `${variable}=${token}\n`, {
    mode: 0o600
  });
  chmodSync(filePath, 0o600);
}

function publishLaunchdToken(token: string, env: NodeJS.ProcessEnv): void {
  if (env.AUTODEV_SKIP_LAUNCHCTL === "1") return;
  try {
    execFileSync("launchctl", ["setenv", ROUTER_AUTH_VARIABLE, token], {
      stdio: "ignore"
    });
  } catch {
    /* launchd may be inaccessible in a sandbox */
  }
}

function ensurePrivateToken(
  filePath: string,
  variable: string
): {
  token: string;
  created: boolean;
} {
  const token = existingToken(filePath, variable);
  if (token) {
    chmodSync(filePath, 0o600);
    return { token, created: false };
  }
  const generated = randomBytes(32).toString("hex");
  appendToken(filePath, variable, generated);
  return { token: generated, created: true };
}

export function ensureRouterAuth(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const result = ensurePrivateToken(filePath, ROUTER_AUTH_VARIABLE);
  writeErrorLine(
    result.created
      ? `created router auth token in ${filePath}`
      : `ok router auth token already exists in ${filePath}`
  );
  publishLaunchdToken(result.token, env);
  return result.token;
}

/** Ensure every bridge's Router credential exists; returns each token by bridge. */
export function ensureBridgeRouterAuth(
  filePath: string
): Record<keyof typeof BRIDGE_ROUTER_AUTH_VARIABLES, string> {
  const tokens = {} as Record<
    keyof typeof BRIDGE_ROUTER_AUTH_VARIABLES,
    string
  >;
  for (const [bridge, variable] of Object.entries(
    BRIDGE_ROUTER_AUTH_VARIABLES
  ) as [keyof typeof BRIDGE_ROUTER_AUTH_VARIABLES, string][]) {
    const result = ensurePrivateToken(filePath, variable);
    writeErrorLine(
      result.created
        ? `created ${bridge} bridge auth token in ${filePath}`
        : `ok ${bridge} bridge auth token already exists in ${filePath}`
    );
    tokens[bridge] = result.token;
  }
  return tokens;
}

function cli(argv: string[]): number {
  const [command, filePath, value] = argv;
  if (command === "auth" && filePath && value === undefined) {
    ensureRouterAuth(filePath);
    return 0;
  }
  throw new Error("usage: install-state auth <env-file>");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `install-state: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
