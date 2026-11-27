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

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import {
  deleteKeychainSecret,
  isKeychainSecretName,
  KEYCHAIN_SECRET_NAMES,
  keychainAvailable,
  type KeychainDeps,
  type KeychainSecretName,
  readKeychainSecret,
  writeKeychainSecret
} from "@simulatorlife/autodev-runtime/shared/runtime-secrets";

export const ROUTER_AUTH_VARIABLE = "CODEX_ROUTER_AUTH_TOKEN";
/**
The private Router-to-bridge credentials, one per bridge that authenticates
the router. Each is loaded by both the router's and that bridge's launcher,
and never forwarded into the provider process the bridge runs.
*/
export const BRIDGE_ROUTER_AUTH_VARIABLES = {
  Copilot: "CODEX_ROUTER_COPILOT_API_KEY",
  opencli: "CODEX_ROUTER_OPENCLI_API_KEY"
} as const;

const LINE_SPLIT_PATTERN = /\r?\n/u;

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

function publishLaunchdToken(token: string, environment: NodeJS.ProcessEnv): void {
  if (environment.AUTODEV_SKIP_LAUNCHCTL === "1") return;
  try {
    execFileSync("launchctl", ["setenv", ROUTER_AUTH_VARIABLE, token], {
      stdio: "ignore"
    });
  } catch {
    /*
    launchd may be inaccessible in a sandbox
    */
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
  environment: NodeJS.ProcessEnv = process.env
): string {
  const result = ensurePrivateToken(filePath, ROUTER_AUTH_VARIABLE);
  writeErrorLine(
    result.created
      ? `created router auth token in ${filePath}`
      : `ok router auth token already exists in ${filePath}`
  );
  publishLaunchdToken(result.token, environment);
  return result.token;
}

/**
Ensure every bridge's Router credential exists; returns each token by bridge.
*/
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

function parseEnvironmentAssignment(
  rawLine: string
): { key: string; value: string } | null {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const assignment = trimmed.startsWith("export ")
    ? trimmed.slice(7).trim()
    : trimmed;
  const separator = assignment.indexOf("=");
  if (separator < 1) return null;
  const key = assignment.slice(0, separator).trim();
  let value = assignment.slice(separator + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

/**
Return the list of Keychain-managed secret names present in an env file.
*/
export function findPlaintextKeychainSecrets(
  filePath: string,
  targets: readonly KeychainSecretName[] = KEYCHAIN_SECRET_NAMES
): KeychainSecretName[] {
  if (!existsSync(filePath)) return [];
  const targetSet = new Set<string>(targets);
  const found = new Set<KeychainSecretName>();
  for (const line of readFileSync(filePath, "utf8").split(LINE_SPLIT_PATTERN)) {
    const parsed = parseEnvironmentAssignment(line);
    if (parsed && targetSet.has(parsed.key) && parsed.value.trim()) {
      found.add(parsed.key as KeychainSecretName);
    }
  }
  return [...found];
}

/**
Migrate Keychain-managed secrets out of `$CODEX_HOME/.env` into macOS
Keychain, verifying each Keychain write before atomically rewriting the env
file without those plaintext secrets.
*/
export function migrateEnvSecretsToKeychain(
  filePath: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    readonly secrets?: readonly KeychainSecretName[];
    readonly deps?: KeychainDeps;
  } = {}
): KeychainSecretName[] {
  if (!existsSync(filePath)) return [];
  const dependencies = options.deps ?? {};
  if (!keychainAvailable(environment, dependencies)) return [];
  const targets = new Set<string>(options.secrets ?? KEYCHAIN_SECRET_NAMES);
  const rawContent = readFileSync(filePath, "utf8");
  const lines = rawContent.split(LINE_SPLIT_PATTERN);
  const extracted = new Map<KeychainSecretName, string>();
  for (const line of lines) {
    const parsed = parseEnvironmentAssignment(line);
    if (parsed && targets.has(parsed.key)) {
      const value = parsed.value.trim();
      if (value) extracted.set(parsed.key as KeychainSecretName, value);
    }
  }
  if (extracted.size === 0) return [];
  const migrated: KeychainSecretName[] = [];
  for (const [name, value] of extracted) {
    writeKeychainSecret(name, value, environment, dependencies);
    if (readKeychainSecret(name, environment, { deps: dependencies }) !== value) {
      throw new Error(`Keychain verification failed while migrating ${name}`);
    }
    migrated.push(name);
    writeErrorLine(`migrated ${name} from ${filePath} to macOS Keychain`);
  }
  const migratedSet = new Set<string>(migrated);
  const remaining = lines.filter((line) => {
    const parsed = parseEnvironmentAssignment(line);
    return !parsed || !migratedSet.has(parsed.key);
  });
  const nextContent =
    remaining.length === 0 || (remaining.length === 1 && remaining[0] === "")
      ? ""
      : `${remaining.join("\n").replace(/\n*$/u, "")}\n`;
  atomicWriteSync(filePath, nextContent, { mode: 0o600, skipUnchanged: true });
  chmodSync(filePath, 0o600);
  return migrated;
}

export const REQUIRED_INSTALL_KEYCHAIN_SECRETS: readonly KeychainSecretName[] =
  ["MINIMAX_API_KEY", "CONTEXT7_API_KEY"];

/**
Verify that required API keys exist in macOS Keychain without writing or
migrating Keychain entries or modifying `.env`. Returns any missing keys.
*/
export function checkRequiredKeychainSecrets(
  names: readonly KeychainSecretName[] = REQUIRED_INSTALL_KEYCHAIN_SECRETS,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: KeychainDeps = {}
): KeychainSecretName[] {
  if (!keychainAvailable(environment, dependencies)) return [];
  return names.filter(
    (name) => readKeychainSecret(name, environment, { deps: dependencies }) === null
  );
}

function cli(argv: string[]): number {
  const [command, subcommand, target, extra] = argv;
  if (command === "auth" && subcommand && target === undefined) {
    ensureRouterAuth(subcommand);
    return 0;
  }
  if (command === "keychain") {
    if (subcommand === "set" && target && extra === undefined) {
      if (!isKeychainSecretName(target)) {
        throw new Error(
          `unsupported Keychain secret: ${target} (expected one of: ${KEYCHAIN_SECRET_NAMES.join(", ")})`
        );
      }
      const value = readFileSync(0, "utf8").trim();
      writeKeychainSecret(target, value);
      writeLine(`stored ${target} in macOS Keychain`);
      return 0;
    }
    if (subcommand === "delete" && target && extra === undefined) {
      if (!isKeychainSecretName(target)) {
        throw new Error(
          `unsupported Keychain secret: ${target} (expected one of: ${KEYCHAIN_SECRET_NAMES.join(", ")})`
        );
      }
      const deleted = deleteKeychainSecret(target);
      writeLine(
        deleted
          ? `deleted ${target} from macOS Keychain`
          : `${target} was not present in macOS Keychain`
      );
      return 0;
    }
    if (subcommand === "status" && extra === undefined) {
      const names = target ? [target] : [...KEYCHAIN_SECRET_NAMES];
      for (const name of names) {
        if (!isKeychainSecretName(name)) {
          throw new Error(
            `unsupported Keychain secret: ${name} (expected one of: ${KEYCHAIN_SECRET_NAMES.join(", ")})`
          );
        }
        const isPresent = readKeychainSecret(name) !== null;
        writeLine(`${name}: ${isPresent ? "present" : "missing"}`);
      }
      return 0;
    }
    if (subcommand === "migrate" && target && extra === undefined) {
      migrateEnvSecretsToKeychain(target);
      return 0;
    }
  }
  throw new Error(
    "usage: install-state auth <env-file> | keychain <set|delete|status|migrate> [target]"
  );
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `install-state: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
