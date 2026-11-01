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
export const COPILOT_ROUTER_AUTH_VARIABLE = "CODEX_ROUTER_COPILOT_API_KEY";

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

/** The private Router-to-Copilot bridge credential is loaded by both launchers. */
export function ensureCopilotRouterAuth(filePath: string): string {
  const result = ensurePrivateToken(filePath, COPILOT_ROUTER_AUTH_VARIABLE);
  writeErrorLine(
    result.created
      ? `created Copilot bridge auth token in ${filePath}`
      : `ok Copilot bridge auth token already exists in ${filePath}`
  );
  return result.token;
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
