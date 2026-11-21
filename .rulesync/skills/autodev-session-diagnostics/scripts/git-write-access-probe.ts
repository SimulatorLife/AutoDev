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

import {
  parseTurnsFile,
  type SseEvent,
  startRecorder
} from "../../autodev-codex-request-capture/scripts/responses-recorder.ts";

const EXAMPLE_TURNS = new URL(
  "../../autodev-codex-request-capture/examples/exec-command.turns.json",
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
      writes: true
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
  /** Only run the cases whose command contains this text. */
  readonly filter?: string;
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

function configToml(port: number): string {
  return [
    'model = "MiniMax-M3"',
    'model_provider = "probe"',
    "model_catalog_json = " + JSON.stringify(MODEL_CATALOG),
    'sandbox_mode = "workspace-write"',
    'approval_policy = "never"',
    "",
    "[model_providers.probe]",
    'name = "probe recorder"',
    'base_url = "http://127.0.0.1:' + port + '/v1"',
    'env_key = "PROBE_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    ""
  ].join("\n");
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
export function writeReachedRepository(work: string): boolean {
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
  writeFileSync(path.join(home, "config.toml"), configToml(port));
  const run = await runCodex(options.codex, home, work);
  await closeServer(server);

  const staged = writeReachedRepository(work);
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
  const cases = writeAccessCases().filter(
    (testCase) =>
      options.filter === undefined || testCase.command.includes(options.filter)
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

async function main(argv: readonly string[]): Promise<number> {
  let codex = "codex";
  let rules = REPOSITORY_RULES;
  let keep = false;
  let filter: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--codex") {
      const value = argv[index + 1];
      if (value === undefined) {
        process.stderr.write("--codex needs a binary path\n");
        return 2;
      }
      codex = value;
      index += 1;
    } else if (argument === "--rules") {
      const value = argv[index + 1];
      if (value === undefined) {
        process.stderr.write("--rules needs a path\n");
        return 2;
      }
      rules = path.resolve(value);
      index += 1;
    } else if (argument === "--keep") keep = true;
    else if (argument === "--filter") {
      const value = argv[index + 1];
      if (value === undefined) {
        process.stderr.write("--filter needs a value\n");
        return 2;
      }
      filter = value;
      index += 1;
    } else {
      process.stderr.write("unknown argument " + argument + "\n");
      return 2;
    }
  }
  process.stdout.write("codex: " + (await codexVersion(codex)) + "\n");
  process.stdout.write("rules:  " + rules + "\n\n");
  const results = await probeWriteAccess({ codex, rules, keep, filter });
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
