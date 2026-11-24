#!/usr/bin/env node

/**
 * Probe whether Codex can write to `.git` under the repository's command rules.
 *
 * The workspace-write sandbox keeps `<root>/.git` read-only, so a staging
 * command that is allowed to run outside the sandbox can write the index and
 * a staging command that stays inside it cannot. The rules in
 * `agents/rules/default.rules` grant that exemption to the Git commands that
 * need it, but the exemption is per command: a command the model issues
 * together with another one (chained with `&&` or `;`), or a command the
 * model issues in a shape Codex runs on another path (an explicit shell, a
 * command too long to run directly), is judged as a whole, so the exemption
 * is lost and the write fails with `.git/index.lock: Operation not permitted`.
 *
 * The probe proves which command forms keep the write access. It runs a real
 * Codex against a throwaway Git repository and an isolated CODEX_HOME holding
 * the repository's rules file, so it needs no API key and no network: the
 * model is a scripted fake provider.
 *
 *   node git-write-access-probe.ts [--codex <binary>] [--rules <path>] [--keep]
 *
 * "--keep" leaves the throwaway CODEX_HOME and repository behind and prints
 * their paths.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseToml } from "smol-toml";

import {
  parseTurnsFile,
  type SseEvent,
  startRecorder
} from "../../autodev-request-capture/scripts/responses-recorder.ts";

const EXAMPLE_TURNS = new URL(
  "../../autodev-request-capture/examples/exec-command.turns.json",
  import.meta.url
);
const MODEL_CATALOG = fileURLToPath(
  new URL(
    "../../../../config/catalogs/minimax-model-catalog.json",
    import.meta.url
  )
);
const REPOSITORY_RULES = fileURLToPath(
  new URL("../../../../agents/rules/default.rules", import.meta.url)
);
/** How many paths the long-command case stages. */
const LONG_COMMAND_PATHS = 128;
/** The staging command every case starts from. */
const STAGE = "git add file.txt";

export interface WriteAccessCase {
  /** The arguments the scripted model passes to `exec_command`. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** The command, for the report. */
  readonly command: string;
  /** What the case is meant to show. */
  readonly intent: string;
  /** Whether the command is meant to write to `.git` at all. */
  readonly writes: boolean;
  /** A command run in the work dir after the run; its output means the write happened. */
  readonly check?: string;
}

/**
 * The command forms an agent actually uses. The staging command is the one
 * that needs `.git` to be writable; the others are the forms that either keep
 * or lose the exemption.
 */
export function writeAccessCases(): readonly WriteAccessCase[] {
  const longPaths = Array.from(
    { length: LONG_COMMAND_PATHS },
    (_unused, index) => `path-${String(index).padStart(3, "0")}.txt`
  ).join(" ");
  return [
    {
      arguments: { cmd: STAGE },
      command: STAGE,
      intent: "a staging command on its own",
      writes: true
    },
    {
      arguments: { cmd: "git add -- file.txt" },
      command: "git add -- file.txt",
      intent: "the staging command with an end-of-options marker",
      writes: true
    },
    {
      arguments: { cmd: STAGE, shell: "/bin/bash" },
      command: "git add file.txt (shell: /bin/bash)",
      intent: "the staging command with an explicit shell",
      writes: true
    },
    {
      arguments: { cmd: STAGE, shell: "/bin/zsh" },
      command: "git add file.txt (shell: /bin/zsh)",
      intent: "the staging command with the default shell named explicitly",
      writes: true
    },
    {
      arguments: { cmd: STAGE, shell: "/usr/local/bin/bash" },
      command: "git add file.txt (shell: /usr/local/bin/bash)",
      intent: "the staging command with the Homebrew bash by path",
      writes: true
    },
    {
      arguments: { cmd: STAGE, shell: "/bin/sh" },
      command: "git add file.txt (shell: /bin/sh)",
      intent: "the staging command with a plain shell",
      writes: true
    },
    {
      arguments: { cmd: `git add -- ${longPaths}` },
      command: `git add -- <${LONG_COMMAND_PATHS} paths>`,
      intent: "the staging command with more paths than a command line carries",
      writes: true
    },
    {
      arguments: { cmd: "git add file.txt && git status --short" },
      command: "git add file.txt && git status --short",
      intent: "the staging command chained with a read-only command",
      writes: true
    },
    {
      arguments: { cmd: "git add file.txt; git status --short" },
      command: "git add file.txt; git status --short",
      intent: "the staging command chained with a semicolon",
      writes: true
    },
    {
      arguments: { cmd: "git add file.txt && git diff --cached --stat" },
      command: "git add file.txt && git diff --cached --stat",
      intent: "the staging command chained with a diff",
      writes: true
    },
    {
      arguments: { cmd: "git add file.txt && git commit -m probe-commit" },
      command: "git add file.txt && git commit -m probe-commit",
      intent: "the staging command chained with the commit",
      writes: true,
      check: "git log --oneline"
    },
    {
      arguments: { cmd: "cd . && git add file.txt" },
      command: "cd . && git add file.txt",
      intent: "the staging command chained with a directory change",
      writes: true
    },
    {
      arguments: { cmd: "git add file.txt 2>&1" },
      command: "git add file.txt 2>&1",
      intent: "the staging command with a redirected stream",
      writes: true
    },
    {
      arguments: { cmd: "git add file.txt | cat" },
      command: "git add file.txt | cat",
      intent: "the staging command piped into another command",
      writes: true
    },
    {
      arguments: { cmd: "for f in file.txt; do git add $f; done" },
      command: "for f in file.txt; do git add $f; done",
      intent: "the staging command inside a shell loop",
      writes: true
    },
    {
      arguments: { cmd: "touch .git/probe-write" },
      command: "touch .git/probe-write",
      intent: "a non-git command writing into .git",
      writes: true,
      check: "test -f .git/probe-write && echo yes"
    },
    {
      arguments: { cmd: "git config core.hooksPath /tmp/evil-hooks" },
      command: "git config core.hooksPath /tmp/evil-hooks",
      intent: "a command that plants a hook in .git/config",
      writes: true,
      check: "git config --get core.hooksPath"
    },
    {
      arguments: { cmd: "git status --short" },
      command: "git status --short",
      intent: "a read-only command on its own",
      writes: false
    }
  ];
}

export interface WriteAccessResult {
  readonly command: string;
  readonly intent: string;
  /** Whether the command is meant to write to `.git` at all. */
  readonly writes: boolean;
  /** Whether the write reached the repository: staged in the index or committed. */
  readonly staged: boolean;
  /** The tool result the model saw. */
  readonly detail: string;
}

export interface WriteAccessOptions {
  readonly codex: string;
  readonly rules: string;
  readonly keep: boolean;
  /** A Codex permission profile to add to the probe's own config. */
  readonly permissionProfile?: string | undefined;
  /** Drop "sandbox_mode" from the probe's config, so a profile is the only policy. */
  readonly noSandboxMode?: boolean | undefined;
  /** Extra sandbox writable roots; "%WORK%" is the case's work directory. */
  readonly writableRoots?: readonly string[] | undefined;
  /** Only run the cases whose command contains this text. */
  readonly filter?: string | undefined;
}

/** The scripted turns the fake provider serves: one command, then one message. */
export function writeAccessTurns(
  args: Readonly<Record<string, unknown>>
): SseEvent[][] {
  const raw = readFileSync(EXAMPLE_TURNS, "utf8");
  const escapedMarker = JSON.stringify(
    JSON.stringify({ cmd: "echo autodev-probe" })
  ).slice(1, -1);
  const escapedArgs = JSON.stringify(JSON.stringify(args)).slice(1, -1);
  const replaced = raw.replaceAll(escapedMarker, escapedArgs);
  if (replaced === raw) {
    throw new Error("the example turns no longer carry the probe command");
  }
  return parseTurnsFile(JSON.parse(replaced) as unknown);
}

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/u;

/** A TOML key: bare when it can be, quoted when it cannot. */
function tomlKey(key: string): string {
  return BARE_TOML_KEY.test(key) ? key : JSON.stringify(key);
}

/** A TOML table, recursively. */
function emitTomlTable(header: string, body: unknown): string {
  const lines = [`[${header}]`];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      lines.push(emitTomlTable(`${header}.${tomlKey(key)}`, value));
      continue;
    }
    lines.push(`${tomlKey(key)} = ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

/**
 * A Codex permission profile, split into the top-level keys and the tables.
 * TOML needs the top-level keys before the first table header, so the two
 * halves cannot simply be appended.
 */
export function splitProfile(profile: string): {
  readonly scalars: readonly string[];
  readonly tables: readonly string[];
} {
  const parsed = parseToml(profile) as Record<string, unknown>;
  const scalars: string[] = [];
  const tables: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "permissions" && value !== null && typeof value === "object") {
      for (const [name, body] of Object.entries(
        value as Record<string, unknown>
      )) {
        tables.push(emitTomlTable(`permissions.${name}`, body));
      }
      continue;
    }
    scalars.push(`${key} = ${JSON.stringify(value)}`);
  }
  return { scalars, tables };
}

function configToml(
  port: number,
  writableRoots: readonly string[] = []
): { readonly scalars: readonly string[]; readonly tables: readonly string[] } {
  return {
    scalars: [
      'model = "MiniMax-M3"',
      'model_provider = "probe"',
      "model_catalog_json = " + JSON.stringify(MODEL_CATALOG),
      process.env.AUTODEV_PROBE_NO_SANDBOX === "1"
        ? ""
        : 'sandbox_mode = "workspace-write"',
      'approval_policy = "never"'
    ].filter((line) => line !== ""),
    tables: [
      "[sandbox_workspace_write]",
      "writable_roots = [" +
        writableRoots.map((root) => JSON.stringify(root)).join(", ") +
        "]",
      "[model_providers.probe]",
      'name = "probe recorder"',
      'base_url = "http://127.0.0.1:' + port + '/v1"',
      'env_key = "PROBE_API_KEY"',
      'wire_api = "responses"',
      "requires_openai_auth = false"
    ]
  };
}

/** The tool result the model saw, which is where the failure shows up. */
export function recordedToolOutput(record: string): string | null {
  if (!existsSync(record)) return null;
  const lines = readFileSync(record, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  for (const line of lines.reverse()) {
    let body: { input?: unknown };
    try {
      body = (JSON.parse(line) as { body?: { input?: unknown } }).body ?? {};
    } catch {
      continue;
    }
    const input = body.input;
    if (!Array.isArray(input)) continue;
    for (const item of input) {
      const entry = item as { type?: unknown; output?: unknown } | null;
      if (
        entry?.type === "function_call_output" &&
        typeof entry.output === "string"
      )
        return entry.output;
    }
  }
  return null;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function runCodex(
  codex: string,
  home: string,
  work: string
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(codex, ["exec", "--skip-git-repo-check", "go"], {
    cwd: work,
    env: { ...process.env, CODEX_HOME: home, PROBE_API_KEY: "probe" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.resume();
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", (value) => resolve(value));
  });
  return { code, stderr };
}

/**
 * Whether the write reached the repository: something is in the index, or the
 * command committed it.
 */
export function writeReachedRepository(work: string, check?: string): boolean {
  if (check !== undefined) {
    const result = spawnSync("sh", ["-c", check], {
      cwd: work,
      encoding: "utf8"
    });
    return result.status === 0 && result.stdout.trim() !== "";
  }
  const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
    cwd: work,
    encoding: "utf8"
  });
  if (staged.status === 0 && staged.stdout.trim() !== "") return true;
  const log = spawnSync("git", ["log", "--oneline"], {
    cwd: work,
    encoding: "utf8"
  });
  return log.status === 0 && log.stdout.trim() !== "";
}

async function runCase(
  testCase: WriteAccessCase,
  options: WriteAccessOptions
): Promise<WriteAccessResult> {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-git-write-probe-"));
  const home = path.join(root, "codex-home");
  const rulesDir = path.join(home, "rules");
  const work = path.join(root, "work");
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  // The rules entry has to be a regular file directly inside the rules
  // directory: Codex skips anything else silently.
  copyFileSync(options.rules, path.join(rulesDir, "default.rules"));
  spawnSync("git", ["init", "-q"], { cwd: work, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "probe@example.com"], {
    cwd: work,
    encoding: "utf8"
  });
  spawnSync("git", ["config", "user.name", "probe"], {
    cwd: work,
    encoding: "utf8"
  });
  writeFileSync(path.join(work, "file.txt"), "probe\n");
  for (let index = 0; index < LONG_COMMAND_PATHS; index += 1) {
    writeFileSync(
      path.join(work, `path-${String(index).padStart(3, "0")}.txt`),
      "probe\n"
    );
  }

  const record = path.join(root, "record.jsonl");
  const server = await startRecorder({
    port: 0,
    record,
    turns: writeAccessTurns(testCase.arguments)
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  const roots = (options.writableRoots ?? []).map((writableRoot) =>
    writableRoot.replaceAll("%WORK%", work)
  );
  if (options.noSandboxMode === true)
    process.env.AUTODEV_PROBE_NO_SANDBOX = "1";
  const profile =
    options.permissionProfile === undefined
      ? { scalars: [] as string[], tables: [] as string[] }
      : splitProfile(readFileSync(options.permissionProfile, "utf8"));
  const probeConfig = configToml(port, roots);
  // The probe's own keys win: a profile that also carries an approval policy
  // would otherwise make Codex ask, and the probe cannot answer.
  const probeKeys = new Set(
    probeConfig.scalars.map((line) => line.slice(0, line.indexOf("=")).trim())
  );
  const profileScalars = profile.scalars.filter(
    (line) => !probeKeys.has(line.slice(0, line.indexOf("=")).trim())
  );
  writeFileSync(
    path.join(home, "config.toml"),
    [
      ...probeConfig.scalars,
      ...profileScalars,
      ...probeConfig.tables,
      ...profile.tables
    ].join("\n") + "\n"
  );
  const run = await runCodex(options.codex, home, work);
  await closeServer(server);

  const staged = writeReachedRepository(work, testCase.check);
  const detail = recordedToolOutput(record) ?? run.stderr.trim();
  if (options.keep) process.stderr.write("kept " + root + "\n");
  else
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200
    });
  return {
    command: testCase.command,
    intent: testCase.intent,
    writes: testCase.writes,
    staged,
    detail
  };
}

export async function probeWriteAccess(
  options: WriteAccessOptions
): Promise<WriteAccessResult[]> {
  const results: WriteAccessResult[] = [];
  const needles =
    options.filter === undefined
      ? []
      : options.filter.split(",").filter((needle) => needle !== "");
  const cases = writeAccessCases().filter(
    (testCase) =>
      needles.length === 0 ||
      needles.some((needle) => testCase.command.includes(needle))
  );
  for (const testCase of cases) {
    // eslint-disable-next-line no-await-in-loop -- one real Codex at a time: concurrent probes would compete for the machine and make a sandbox verdict noisy
    results.push(await runCase(testCase, options));
  }
  return results;
}

function describe(result: WriteAccessResult): string {
  return [
    "command  " + result.command,
    "intent   " + result.intent,
    "wrote    " + (result.staged ? "yes" : "no"),
    "result   " + result.detail.replaceAll(/\s+/gu, " ").slice(0, 600)
  ].join("\n");
}

function codexVersion(binary: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.resume();
    child.on("close", () =>
      resolve(output.trim() || binary + " (version unavailable)")
    );
  });
}

interface ProbeArguments {
  readonly codex: string;
  readonly rules: string;
  readonly keep: boolean;
  readonly filter: string | undefined;
  readonly permissionProfile: string | undefined;
  readonly writableRoots: readonly string[];
  readonly noSandboxMode: boolean;
}

/** Read one option's value, or report that it is missing. */
function optionValue(
  argv: readonly string[],
  index: number,
  name: string
): { readonly value: string; readonly next: number } | null {
  const value = argv[index + 1];
  if (value === undefined) {
    process.stderr.write(name + " needs a value\n");
    return null;
  }
  return { value, next: index + 1 };
}

export function parseArguments(argv: readonly string[]): ProbeArguments | null {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--keep" || argument === "--no-sandbox-mode") {
      flags.add(argument);
      continue;
    }
    const parsed = optionValue(argv, index, argument);
    if (parsed === null) return null;
    values.set(argument, [...(values.get(argument) ?? []), parsed.value]);
    index = parsed.next;
  }
  const known = new Set([
    "--codex",
    "--rules",
    "--writable-root",
    "--permission-profile",
    "--filter"
  ]);
  for (const argument of values.keys()) {
    if (!known.has(argument)) {
      process.stderr.write("unknown argument " + argument + "\n");
      return null;
    }
  }
  const first = (argument: string): string | undefined =>
    values.get(argument)?.[0];
  const rulesValue = first("--rules");
  const profileValue = first("--permission-profile");
  return {
    codex: first("--codex") ?? "codex",
    rules:
      rulesValue === undefined ? REPOSITORY_RULES : path.resolve(rulesValue),
    keep: flags.has("--keep"),
    filter: first("--filter"),
    permissionProfile:
      profileValue === undefined ? undefined : path.resolve(profileValue),
    writableRoots: values.get("--writable-root") ?? [],
    noSandboxMode: flags.has("--no-sandbox-mode")
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const arguments_ = parseArguments(argv);
  if (arguments_ === null) return 2;
  const { codex, rules, keep, filter, permissionProfile, writableRoots } =
    arguments_;
  process.stdout.write("codex: " + (await codexVersion(codex)) + "\n");
  process.stdout.write("rules:  " + rules + "\n\n");
  const results = await probeWriteAccess({
    codex,
    rules,
    keep,
    filter,
    permissionProfile,
    writableRoots,
    noSandboxMode: arguments_.noSandboxMode
  });
  for (const result of results) process.stdout.write(describe(result) + "\n\n");
  const writing = results.filter((result) => result.writes);
  const writable = writing.filter((result) => result.staged);
  const blocked = writing.filter((result) => !result.staged);
  process.stdout.write(
    "writable: " +
      (writable.length === 0
        ? "none"
        : writable.map((r) => r.command).join(" | ")) +
      "\n"
  );
  process.stdout.write(
    "no write access: " +
      (blocked.length === 0
        ? "none"
        : blocked.map((r) => r.command).join(" | ")) +
      "\n"
  );
  return blocked.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(await main(process.argv.slice(2)));
}
