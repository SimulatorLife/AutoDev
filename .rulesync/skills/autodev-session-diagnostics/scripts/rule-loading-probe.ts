#!/usr/bin/env node

/**
Probe how Codex loads the command rules in "$CODEX_HOME/rules".

Codex loads a rules entry only when it resolves to a file that sits
directly in the rules directory. An entry that resolves anywhere else -- a
symlink into the repository checkout, for example -- is skipped without a
word: every rule in that file turns inert, so an "allow" rule stops
lifting the workspace-write sandbox and a "forbidden" rule stops blocking
anything. "codex execpolicy check" cannot see this: it resolves the path
itself and reports the decision the skipped file would have produced.

The probe proves that with a real Codex run against a throwaway
CODEX_HOME and a scripted fake provider, so it needs no API key and no
network. It writes one "forbidden" rule (touch), has the fake model run
"touch probe-marker", and reads the tool result: a policy rejection means
the rules file was loaded, anything else means it was skipped.

  node rule-loading-probe.ts [--codex <binary>] [--keep]

"--keep" leaves the throwaway CODEX_HOME and workdir behind and prints
their path. The probe runs from the repository checkout: it reads the
local model catalog and the request-capture skill's scripted turns.
*/

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
const PROBE_COMMAND = "touch probe-marker";
const REJECTED = /rejected/iu;
const PROBE_RULES = [
  "prefix_rule(",
  '    pattern = ["touch"],',
  '    decision = "forbidden",',
  '    justification = "probe: prove whether Codex loaded this rules file",',
  ")",
  ""
].join("\n");

export type ProbeCase = "regular" | "symlink";

export interface RuleEntryVerdict {
  /**
  The rules directory entry Codex reads, for example ".../rules/default.rules".
  */
  readonly entry: string;
  /**
  What that entry resolves to on disk.
  */
  readonly resolved: string;
  /**
  Whether Codex loads it.
  */
  readonly loads: boolean;
  readonly reason: string;
}

export interface ProbeCaseResult {
  readonly case: ProbeCase;
  readonly verdict: RuleEntryVerdict;
  /**
  Whether the rule in the file was enforced, which is the loader's decision.
  */
  readonly enforced: boolean;
  readonly detail: string;
}

export interface ProbeOptions {
  readonly codex: string;
  readonly keep: boolean;
}

/**
Decide whether Codex loads a rules directory entry.

The entry is loaded only when it resolves to a file directly in the rules
directory: a symlink whose target sits elsewhere -- in the repository
checkout, in CODEX_HOME but outside "rules/", or in a subdirectory of
"rules/" -- resolves outside that directory and is skipped silently.
*/
export function ruleEntryLoads(
  rulesDir: string,
  entry: string
): RuleEntryVerdict {
  const resolvedDir = realpathSync(rulesDir);
  const resolved = realpathSync(entry);
  const parent = path.dirname(resolved);
  const isLoads = parent === resolvedDir;
  return {
    entry,
    resolved,
    loads: isLoads,
    reason: isLoads
      ? "resolves to a file directly in the rules directory"
      : "resolves to " +
        parent +
        ", outside " +
        resolvedDir +
        "; Codex skips it silently"
  };
}

/**
The scripted turns the fake provider serves: one command, then one message.
*/
export function probeTurns(command = PROBE_COMMAND): SseEvent[][] {
  const raw = readFileSync(EXAMPLE_TURNS, "utf8")
    .split("echo autodev-probe")
    .join(command);
  return parseTurnsFile(JSON.parse(raw) as unknown);
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

/**
The tool result the model saw, which is where a policy rejection shows up.
*/
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

async function runCase(
  name: ProbeCase,
  options: ProbeOptions
): Promise<ProbeCaseResult> {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-rule-probe-"));
  const home = path.join(root, "codex-home");
  const rulesDir = path.join(home, "rules");
  const work = path.join(root, "work");
  const source = path.join(root, "probe.rules");
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(source, PROBE_RULES);
  const entry = path.join(rulesDir, "default.rules");
  if (name === "regular") copyFileSync(source, entry);
  else symlinkSync(source, entry);
  const verdict = ruleEntryLoads(rulesDir, entry);

  const record = path.join(root, "record.jsonl");
  const server = await startRecorder({
    port: 0,
    record,
    turns: probeTurns()
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  writeFileSync(path.join(home, "config.toml"), configToml(port));
  const run = await runCodex(options.codex, home, work);
  await closeServer(server);

  const detail = recordedToolOutput(record) ?? run.stderr.trim();
  const result: ProbeCaseResult = {
    case: name,
    verdict,
    enforced: REJECTED.test(detail),
    detail
  };
  if (options.keep) process.stderr.write("kept " + root + "\n");
  else rmSync(root, { recursive: true, force: true });
  return result;
}

export async function probeRuleLoading(
  options: ProbeOptions
): Promise<ProbeCaseResult[]> {
  const regular = await runCase("regular", options);
  const symlink = await runCase("symlink", options);
  return [regular, symlink];
}

function describe(result: ProbeCaseResult): string {
  const entry = result.case === "regular" ? "regular file" : "symlink";
  return [
    entry + ": " + result.verdict.entry,
    "  resolves to      " + result.verdict.resolved,
    "  Codex loads it   " +
      (result.verdict.loads ? "yes" : "no") +
      " (" +
      result.verdict.reason +
      ")",
    "  rule enforced    " + (result.enforced ? "yes" : "no"),
    "  tool result      " + result.detail.replaceAll(/\s+/gu, " ").slice(0, 200)
  ]
    .concat(
      result.enforced ? [] : ["  note             the rule never applied"]
    )
    .join("\n");
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
  let isKeep = false;
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
    } else if (argument === "--keep") isKeep = true;
    else {
      process.stderr.write("unknown argument " + argument + "\n");
      return 2;
    }
  }
  process.stdout.write("codex: " + (await codexVersion(codex)) + "\n\n");
  const results = await probeRuleLoading({ codex, keep: isKeep });
  for (const result of results) process.stdout.write(describe(result) + "\n\n");
  const regular = results.find((result) => result.case === "regular");
  const symlink = results.find((result) => result.case === "symlink");
  if (regular?.enforced === true && symlink?.enforced === false)
    process.stdout.write(
      "VERDICT: Codex loads a rules entry only when it resolves to a file directly inside CODEX_HOME/rules; an entry that resolves outside is skipped silently.\n"
    );
  else
    process.stdout.write(
      "VERDICT: inconclusive -- the two cases did not differ; read the tool results above.\n"
    );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(await main(process.argv.slice(2)));
}
