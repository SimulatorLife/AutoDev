/**
 * Centralized secret resolution and macOS Keychain integration.
 *
 * Reads runtime credentials from explicit environment variables, macOS Keychain
 * via `/usr/bin/security`, or the owner-only `openlit-secrets.env` file without
 * logging or exposing secret values.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync
} from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";

const LINE_BREAK = /\r?\n/u;
const SECURITY_CLI = "/usr/bin/security";
const SECURITY_TIMEOUT_MS = 5000;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/u;

/** Secrets managed through macOS Keychain by AutoDev. */
export const KEYCHAIN_SECRET_NAMES = [
  "MINIMAX_API_KEY",
  "CONTEXT7_API_KEY",
  "GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY",
  "AUTODEV_CHATGPT_TUNNEL_API_KEY"
] as const;

export type KeychainSecretName = (typeof KEYCHAIN_SECRET_NAMES)[number];

const KEYCHAIN_SECRET_SET = new Set<string>(KEYCHAIN_SECRET_NAMES);

export interface KeychainDeps {
  readonly platform?: NodeJS.Platform;
  readonly runSecurity?: (args: readonly string[], input?: string) => string;
}

export function isKeychainSecretName(name: string): name is KeychainSecretName {
  return KEYCHAIN_SECRET_SET.has(name);
}

/** The Keychain item account; launchd may omit USER and inherit LOGNAME=root. */
export function keychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  return env.USER?.trim() || userInfo().username;
}

export function keychainAvailable(
  env: NodeJS.ProcessEnv = process.env,
  deps: KeychainDeps = {}
): boolean {
  if (env.AUTODEV_DISABLE_KEYCHAIN === "1") return false;
  if (
    env.AUTODEV_DISABLE_KEYCHAIN !== "0" &&
    !env.AUTODEV_KEYCHAIN_FILE?.trim() &&
    process.env.AUTODEV_DISABLE_KEYCHAIN === "1"
  ) {
    return false;
  }
  return (deps.platform ?? process.platform) === "darwin";
}

function defaultRunSecurity(args: readonly string[], input?: string): string {
  return execFileSync(SECURITY_CLI, [...args], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    timeout: SECURITY_TIMEOUT_MS
  });
}

function escapeSecurityArg(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function keychainFileArgs(env: NodeJS.ProcessEnv): string[] {
  const customKeychain = env.AUTODEV_KEYCHAIN_FILE?.trim();
  return customKeychain ? [customKeychain] : [];
}

/**
 * Read a generic-password secret from macOS Keychain using `/usr/bin/security`.
 * Returns `null` when unavailable, disabled, or absent; never logs secrets.
 */
export function readKeychainSecret(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly exactAccount?: boolean;
    readonly deps?: KeychainDeps;
  } = {}
): string | null {
  const deps = options.deps ?? {};
  if (!keychainAvailable(env, deps)) return null;
  const runSecurity = deps.runSecurity ?? defaultRunSecurity;
  const extra = keychainFileArgs(env);
  const attempts: string[][] = [
    [
      "find-generic-password",
      "-a",
      keychainAccount(env),
      "-s",
      service,
      "-w",
      ...extra
    ]
  ];
  if (!options.exactAccount) {
    attempts.push(["find-generic-password", "-s", service, "-w", ...extra]);
  }
  for (const args of attempts) {
    try {
      const value = runSecurity(args).trim();
      if (value) return value;
    } catch {
      /* item absent or inaccessible */
    }
  }
  return null;
}

/**
 * Store or update a generic-password secret in macOS Keychain via `security -i`
 * so the secret never appears in process arguments, trusting `/usr/bin/security`
 * for unattended LaunchAgent retrieval without interactive prompts.
 */
export function writeKeychainSecret(
  service: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: KeychainDeps = {}
): void {
  if (!keychainAvailable(env, deps)) {
    throw new Error(`macOS Keychain is unavailable for storing ${service}`);
  }
  if (
    !service.trim() ||
    /\s/u.test(service) ||
    CONTROL_CHAR_PATTERN.test(service)
  ) {
    throw new Error("Invalid Keychain service name");
  }
  if (!value || CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error(
      `Keychain secret ${service} must be non-empty and free of control characters`
    );
  }
  const runSecurity = deps.runSecurity ?? defaultRunSecurity;
  const account = keychainAccount(env);
  const extra = keychainFileArgs(env).map(escapeSecurityArg);
  const command =
    [
      "add-generic-password",
      "-U",
      "-a",
      escapeSecurityArg(account),
      "-s",
      escapeSecurityArg(service),
      "-T",
      escapeSecurityArg(SECURITY_CLI),
      "-w",
      escapeSecurityArg(value),
      ...extra
    ].join(" ") + "\n";
  try {
    runSecurity(["-i"], command);
  } catch {
    throw new Error(`Failed to store ${service} in macOS Keychain`);
  }
}

/**
 * Delete a generic-password secret from macOS Keychain. Returns `true` if a
 * matching item was removed, `false` when no matching item existed.
 */
export function deleteKeychainSecret(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: KeychainDeps = {}
): boolean {
  if (!keychainAvailable(env, deps)) return false;
  const runSecurity = deps.runSecurity ?? defaultRunSecurity;
  const extra = keychainFileArgs(env);
  const attempts: string[][] = [
    [
      "delete-generic-password",
      "-a",
      keychainAccount(env),
      "-s",
      service,
      ...extra
    ],
    ["delete-generic-password", "-s", service, ...extra]
  ];
  let deleted = false;
  for (const args of attempts) {
    try {
      runSecurity(args);
      deleted = true;
    } catch {
      /* item absent */
    }
  }
  return deleted;
}

/**
 * Resolve a Keychain-backed secret with explicit environment variable
 * precedence (`env[name]` overrides macOS Keychain).
 */
export function resolveManagedSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: KeychainDeps = {}
): string | null {
  const direct = env[name]?.trim();
  if (direct) return direct;
  if (!isKeychainSecretName(name)) return null;
  return readKeychainSecret(name, env, { deps });
}

/**
 * Securely overwrite a regular plaintext credential file with zeroes and fsync
 * before removing it. Symlinks are unlinked without touching their target.
 */
export function secureDeleteFile(filePath: string): void {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    rmSync(filePath, { force: true });
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing secure delete on non-file path: ${filePath}`);
  }
  if (stat.size > 0) {
    const fd = openSync(filePath, "r+");
    try {
      const zeros = Buffer.alloc(Math.min(stat.size, 65_536), 0);
      let offset = 0;
      while (offset < stat.size) {
        const chunk = Math.min(zeros.length, stat.size - offset);
        writeSync(fd, zeros, 0, chunk, offset);
        offset += chunk;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  rmSync(filePath, { force: true });
}

function valueFor(content: string, name: string): string | null {
  for (const rawLine of content.split(LINE_BREAK)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator < 1 || assignment.slice(0, separator).trim() !== name)
      continue;
    const raw = assignment.slice(separator + 1).trim();
    const first = raw[0];
    const last = raw.at(-1);
    const quoted =
      raw.length >= 2 &&
      ((first === '"' && last === '"') || (first === "'" && last === "'"));
    const value = quoted ? raw.slice(1, -1) : raw;
    return value || null;
  }
  return null;
}

/**
 * Read an exact secret without logging it. Runtime services use this for
 * role-scoped MCP children so a credential need not be copied into a model
 * process environment or MCP command-line argument.
 */
export function readRuntimeSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const secretFile =
    env.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
    path.join(codexHome, "openlit-secrets.env");
  try {
    return valueFor(readFileSync(secretFile, "utf8"), name);
  } catch {
    return null;
  }
}
