#!/usr/bin/env node
// Tool-call telemetry for SKILL.md reads.
//
// Codex fires this hook with a JSON payload describing the tool call about to
// run. The payload carries the session id and turn id but no router-issued
// request id; the router correlates via the in-flight parent /v1/responses
// request whose session this hook fired inside (see
// `noteBridgeSession`/`recallBridgeSessionRequestId` in codex-model-router.mjs)
// and attributes reads to that turn's provider/model/role/workspace. A session
// the router never served -- including a session between turns or one the
// router has already finished -- resolves to no context, the router drops the
// post, and this script exits silently so it cannot invent an unattributed
// workspace count.
//
// Only canonical SKILL.md files under approved skill roots count; arbitrary
// mentions, writes, list operations, or exposing a skill through the system
// prompt do not. The matcher ("read_file|exec_command") is the gap Codex
// itself uses to gate its read-side telemetry, and the actual read is
// determined by inspecting the tool arguments.
//
// Persistent state lives at $CODEX_HOME/run/skill-read-telemetry/ and is
// bounded so a stuck hook cannot leak disk.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  AGENT_EVENTS_URL_HEADER,
  resolveSkillReadReporter,
  SESSION_ID_HEADER,
  SKILL_READ_SOURCE
} from "../telemetry/agent-events.ts";

const STATE_DIR = path.join(homedir(), ".codex", "run", "skill-read-telemetry");
const SEEN_KEYS_LIMIT = 4096;
const SEEN_VALUE_LIMIT = 4096;
type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type SeenTurn = { has: string[]; tool: string };
type SeenState = { turns: Record<string, SeenTurn>; keys: string[] };

function asObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function asSeenState(value: JsonValue): SeenState {
  const object = asObject(value);
  const turns: Record<string, SeenTurn> = {};
  const rawTurns = asObject(object.turns);
  for (const [turnId, rawTurn] of Object.entries(rawTurns)) {
    const turn = asObject(rawTurn);
    const has = Array.isArray(turn.has)
      ? turn.has.filter((entry): entry is string => typeof entry === "string")
      : [];
    const tool = typeof turn.tool === "string" ? turn.tool : "";
    turns[turnId] = { has, tool };
  }
  const keys = Array.isArray(object.keys)
    ? object.keys.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { turns, keys };
}

const HOME = homedir();
const REPO_ROOT =
  process.env.AUTODEV_REPO_ROOT ||
  path.resolve(path.join(import.meta.dirname, "..", ".."));
// Source roots whose SKILL.md reads count as skill activation telemetry.
// Mirrors the install-time contract in scripts/install.sh and is
// intentionally narrow: a path under a recognised root that ends in `SKILL.md`
// is the only positive signal we accept. Anything else -- symlinks that
// resolve outside the root, non-canonical locations, files that just happen
// to be named SKILL.md in a transitive include -- is ignored.
const SKILL_ROOTS = [
  path.join(HOME, ".agents", "skills"),
  path.join(HOME, ".codex", "skills"),
  path.join(HOME, "AutoDev", ".agents", "skills"),
  path.join(HOME, "AutoDev", ".rulesync", "skills"),
  path.join(REPO_ROOT, ".agents", "skills"),
  path.join(REPO_ROOT, ".rulesync", "skills")
].filter((filePath) => existsSync(filePath));

const TOOL_NAME_KEYS = ["tool_name", "toolName", "name"];
const ARGUMENT_KEYS = [
  "arguments",
  "args",
  "input",
  "params",
  "tool_input",
  "toolInput"
];
const SESSION_ID_KEYS = ["session_id", "sessionId"];
const TURN_ID_KEYS = ["turn_id", "turnId"];
const CODEX_SESSION_KEY = "x-codex-session-id";
const SKILL_READ_TOOL_NAMES = new Set([
  "read_file",
  "readfile",
  "read",
  "exec_command",
  "execcommand",
  "bash"
]);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function pickString(
  payload: JsonValue | undefined,
  keys: string[]
): string | null {
  const object = asObject(payload);
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickObject(
  payload: JsonValue | undefined,
  keys: string[]
): JsonObject | null {
  const object = asObject(payload);
  for (const key of keys) {
    const value = object[key];
    if (value && typeof value === "object" && !Array.isArray(value))
      return value;
    if (typeof value === "string" && value.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          return parsed as JsonObject;
      } catch {
        // A non-JSON argument string is handled by the command matcher below.
      }
    }
  }
  return null;
}

function pickValue(
  payload: JsonValue | undefined,
  keys: string[]
): JsonValue | null {
  const object = asObject(payload);
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function normaliseToolName(name: unknown): string {
  return typeof name === "string"
    ? name
        .trim()
        .toLowerCase()
        .replaceAll(/[\s-]+/g, "_")
    : "";
}

// The payload Codex sends uses different spellings across versions; this
// walks every plausible key and only accepts the payload if at least one tool
// name was present. A pre-tool hook that saw no tool name is a firehose we
// have no signal on, so we drop it instead of guessing.
function extractToolCall(
  payload: JsonValue
): { toolName: string; args: JsonValue } | null {
  const toolName = pickString(payload, TOOL_NAME_KEYS);
  if (!toolName) return null;
  const rawArguments = pickValue(payload, ARGUMENT_KEYS);
  const args = pickObject(payload, ARGUMENT_KEYS) ?? rawArguments ?? {};
  return { toolName, args };
}

// Extract a single path-like argument from a tool call. The shape varies
// across the tools Codex ships -- `read_file` uses `file_path`, `exec_command`
// carries the path inside `cmd` -- so we walk every plausible surface and
// return the first one that names a real file we can resolve. Returning null
// from the helper means "this tool call is not a SKILL.md read"; the hook
// drops it silently rather than logging anything.
function extractReadPath(argsObject: JsonValue): string | null {
  if (typeof argsObject === "string")
    return matchExecCommandPaths(argsObject)[0] ?? null;
  if (
    !argsObject ||
    typeof argsObject !== "object" ||
    Array.isArray(argsObject)
  )
    return null;
  const args = argsObject as JsonObject;
  const directKeys = ["file_path", "filePath", "path", "filepath"];
  for (const key of directKeys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const arrayKeys = ["files", "paths", "file_paths"];
  for (const key of arrayKeys) {
    const value = args[key];
    if (Array.isArray(value) && value.length > 0) {
      const first = value.find(
        (entry) => typeof entry === "string" && entry.trim()
      );
      if (typeof first === "string") return first.trim();
    }
  }
  const candidates = matchExecCommandPaths(args.cmd ?? args.command);
  if (candidates.length === 0) return null;
  // Several read tools take more than one file argument (`grep pat a b`,
  // `rg pat a b`); the canonical SKILL.md is not guaranteed to be the first
  // one on the line, so every candidate is checked against the approved
  // roots and the first that actually resolves to one wins. Falling back to
  // the first candidate when none match keeps prior behaviour for callers
  // that only care about "a path was named", not whether it was a skill.
  for (const candidate of candidates) {
    if (matchSkillPath(normalisePath(candidate))) return candidate;
  }
  return candidates[0] ?? null;
}

// Shell tool names whose command line is treated as a read when it names a
// file argument. `sed` only counts in its `-n` (suppress-output, print via
// explicit `p`) form, matching the print-a-range idiom Codex itself favours;
// a plain `sed 's/a/b/' file` mutates output rather than dumping the file, so
// it is intentionally excluded.
const SKILL_READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "awk",
  "grep"
]);
const SHELL_CONTROL_TOKENS = new Set(["|", "&&", "||", ";", "&"]);

// Splits a shell command into words, honouring single- and double-quoted
// spans so a quoted path containing a space (`cat "/a b/SKILL.md"`) is not
// broken across two tokens. This is not a full shell grammar -- backslash
// escapes and `$()`/backtick substitution are not unwound -- but it is
// enough to recover the plain file arguments Codex's own tool calls put on
// these command lines.
function tokenizeShellWords(cmd: string): string[] {
  const tokens = [];
  const re = /'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g;
  let match;
  while ((match = re.exec(cmd)) !== null) {
    let token = match[0];
    if (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))
    ) {
      token = token.slice(1, -1);
    }
    tokens.push(token);
  }
  return tokens;
}

// A word counts as a path argument, not a flag or a search pattern, only when
// it is absolute or home-relative. Relative shell paths remain excluded so a
// command cannot be attributed to the wrong working directory.
function isPathLikeToken(token: string): string | null {
  if (typeof token !== "string" || !token || token.startsWith("-")) return null;
  if (token.startsWith("/") || token.startsWith("~")) return token;
  return null;
}

// Resolves the raw value of a `cmd`/`command` argument to a single shell
// string. Providers vary in how they shape this: a plain string, an argv
// array (`["bash", "-lc", "cat file"]` or `["cat", "file"]`), or a nested
// object carrying the real command one level down (`{ command: { cmd: "..." } }`).
// Only one level of object nesting is unwrapped -- deeper nesting is not a
// shape any tool call here actually uses, and unwrapping arbitrarily deep
// objects would risk treating unrelated nested strings as commands.
function flattenCommandValue(raw: JsonValue | undefined): string | null {
  let value = raw;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as JsonObject;
    value =
      object.cmd ?? object.command ?? object.script ?? object.value ?? null;
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").join(" ");
  }
  return typeof value === "string" ? value : null;
}

// Every path-like argument following a recognised read command on `cmd`'s
// command line, in the order they appear. Bounded on both axes: overlong
// commands are rejected outright, and only the next 8 words after a read
// command are scanned for a path so a command with a long option list cannot
// make this walk unbounded. Returning every candidate -- not just the first
// -- lets the caller pick out whichever one actually names a SKILL.md when a
// command reads more than one file.
function matchExecCommandPaths(raw: JsonValue | undefined): string[] {
  const cmd = flattenCommandValue(raw);
  if (!cmd || cmd.length > 4096) return [];
  const tokens = tokenizeShellWords(cmd);
  const candidates = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i] ?? "";
    const isSedPrint = word === "sed" && tokens[i + 1] === "-n";
    if (!SKILL_READ_COMMANDS.has(word) && !isSedPrint) continue;
    const start = isSedPrint ? i + 2 : i + 1;
    for (let j = start; j < tokens.length && j < start + 8; j++) {
      const next = tokens[j] ?? "";
      if (SHELL_CONTROL_TOKENS.has(next)) break;
      const filePath = isPathLikeToken(next);
      if (filePath) candidates.push(filePath);
    }
  }
  return candidates;
}

function normalisePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replaceAll(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  let filePath = trimmed;
  if (filePath.startsWith("~")) filePath = path.join(HOME, filePath.slice(1));
  if (!path.isAbsolute(filePath)) filePath = path.resolve(filePath);
  return filePath;
}

// True when `path` resolves to a `<root>/<skill-name>/SKILL.md` for one of
// the approved roots, regardless of the platform's separator. Returning
// `{ skill }` rather than just true preserves the directory name as the
// canonical skill identifier the dashboard renders; we deliberately do not
// keep absolute paths in telemetry.
const LEADING_SEPARATORS = /^[\\/]+/;
const PATH_SEPARATOR = /[\\/]/;

function matchSkillPath(
  filePath: string | null
): { skill: string; root: string } | null {
  if (!filePath) return null;
  const normalised = filePath.replaceAll(/[\\/]+/g, path.sep);
  for (const rootRaw of SKILL_ROOTS) {
    const root = rootRaw.replaceAll(/[\\/]+/g, path.sep);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (!normalised.startsWith(rootWithSep)) continue;
    const relative = normalised
      .slice(root.length)
      .replace(LEADING_SEPARATORS, "");
    if (
      !relative.endsWith(`${path.sep}SKILL.md`) &&
      !relative.endsWith("/SKILL.md")
    )
      continue;
    const segments = relative.split(PATH_SEPARATOR).filter(Boolean);
    if (segments.length !== 2) continue;
    const [skill] = segments;
    if (!skill || skill.includes("..")) continue;
    return { skill, root };
  }
  return null;
}

function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

async function readSeenState(
  sessionId: string
): Promise<{ path: string; value: SeenState }> {
  const filePath = path.join(STATE_DIR, `${sessionId}.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object")
      return { path: filePath, value: asSeenState(parsed as JsonValue) };
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  return { path: filePath, value: { turns: {}, keys: [] } };
}

async function writeSeenState({
  path: filePath,
  value
}: {
  path: string;
  value: SeenState;
}): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, filePath);
}

function pruneKeys(keys: string[], keep: string[]): void {
  const keepSet = new Set(keep);
  for (const key of keys)
    if (!keepSet.has(key)) keys.splice(keys.indexOf(key), 1);
  while (keys.length > SEEN_KEYS_LIMIT) keys.shift();
}

async function alreadyReported({
  sessionId,
  turnId,
  skill,
  root
}: {
  sessionId: string;
  turnId: string;
  skill: string;
  root: string;
}): Promise<boolean> {
  const state = await readSeenState(sessionId);
  const turn = state.value.turns[turnId];
  if (!turn) return false;
  const key = hashKey(skill, root);
  if (turn.has?.includes(key)) return true;
  return false;
}

async function markReported({
  sessionId,
  turnId,
  skill,
  root,
  toolName
}: {
  sessionId: string;
  turnId: string;
  skill: string;
  root: string;
  toolName: string;
}): Promise<void> {
  const state = await readSeenState(sessionId);
  if (!state.value.turns) state.value.turns = {};
  if (!state.value.keys) state.value.keys = [];
  if (!state.value.turns[turnId])
    state.value.turns[turnId] = { has: [], tool: toolName };
  state.value.turns[turnId].has.push(hashKey(skill, root));
  state.value.keys.push(hashKey(sessionId, turnId, skill, root));
  pruneKeys(state.value.keys, state.value.keys.slice(-SEEN_VALUE_LIMIT));
  // Per-turn dedupe needs the key, but a stale turn should not leak disk.
  // Drop turn entries the router has not seen in the last 256 turns; LRU is
  // a bounded approximation, and the keys list retains the dedupe index.
  const turnKeys = Object.keys(state.value.turns);
  while (turnKeys.length > 64) {
    const drop = turnKeys.shift();
    if (drop !== undefined) delete state.value.turns[drop];
  }
  await writeSeenState(state);
}

// Resolve the events URL. The user-level Codex config wires the router to
// http://127.0.0.1:4100; this hook reads the live endpoint from the same
// env vars the bridges use, so a local override is honoured without a
// rebuild.
function resolveEventsUrl() {
  const fromEnv = process.env.AUTODEV_AGENT_EVENTS_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return "http://127.0.0.1:4100/v1/agent-events";
}

async function postSkillUsed({
  sessionId,
  skill,
  root,
  turnId
}: {
  sessionId: string;
  skill: string;
  root: string;
  turnId: string;
}): Promise<void> {
  const reporter = resolveSkillReadReporter({
    [AGENT_EVENTS_URL_HEADER]: resolveEventsUrl(),
    [SESSION_ID_HEADER]: sessionId
  });
  if (!reporter) return;
  const eventId = `read:${sessionId}:${turnId}:${hashKey(skill, root).slice(0, 12)}`;
  // Fail-open: a post failure must not break the model turn. Best-effort by
  // design; reporter.post swallows transport errors and emits a bounded,
  // credential-free loss record so an operator can see it.
  await reporter.reportSkillUsed({
    skill,
    source: SKILL_READ_SOURCE,
    eventId
  });
}

// Resolve the workspace CWD from payload so we can also write it to the
// session state for downstream consumers. Never forwarded in the post body.
function payloadCwd(payload: JsonValue): string | null {
  const object = asObject(payload);
  const candidates = [
    object.cwd,
    object.working_directory,
    object.workingDirectory,
    object.workspace_cwd,
    object.repository_cwd
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function run(): Promise<void> {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }
  let payload: JsonValue;
  try {
    payload = JSON.parse(raw) as JsonValue;
  } catch {
    // Hook receives malformed JSON: no-op rather than surfacing an error to
    // Codex. Telemetry must never fail a turn.
    process.exit(0);
  }
  const tool = extractToolCall(payload);
  if (!tool) return;
  if (!SKILL_READ_TOOL_NAMES.has(normaliseToolName(tool.toolName))) return;
  const candidatePath = extractReadPath(tool.args);
  if (!candidatePath) return;
  const normalised = normalisePath(candidatePath);
  if (!normalised) return;
  const match = matchSkillPath(normalised);
  if (!match) return;
  const payloadObject = asObject(payload);
  const sessionId =
    pickString(payload, SESSION_ID_KEYS) ??
    pickString(payloadObject.metadata, SESSION_ID_KEYS) ??
    (typeof payloadObject[CODEX_SESSION_KEY] === "string"
      ? payloadObject[CODEX_SESSION_KEY]
      : null);
  if (!sessionId) return;
  const turnId =
    pickString(payload, TURN_ID_KEYS) ??
    pickString(payloadObject.metadata, TURN_ID_KEYS) ??
    "no-turn";
  if (
    await alreadyReported({
      sessionId,
      turnId,
      skill: match.skill,
      root: match.root
    })
  )
    return;
  await markReported({
    sessionId,
    turnId,
    skill: match.skill,
    root: match.root,
    toolName: tool.toolName
  });
  await postSkillUsed({
    sessionId,
    skill: match.skill,
    root: match.root,
    turnId
  });
  payloadCwd(payload); // retained for symmetry; not forwarded in the post
}

try {
  await run();
} catch {
  /* fail-open by design */
} finally {
  process.exit(0);
}
