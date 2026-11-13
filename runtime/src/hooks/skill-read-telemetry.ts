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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  extractSkillReadPath,
  matchSkillReadTarget,
  normaliseSkillReadPath
} from "../shared/skill-reads.ts";

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
  // Turn ids are supplied by hook input; a normal object would treat names
  // such as "constructor" and "__proto__" as inherited properties.
  const turns = Object.create(null) as Record<string, SeenTurn>;
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
  return {
    path: filePath,
    value: { turns: Object.create(null) as Record<string, SeenTurn>, keys: [] }
  };
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
  const {
    AGENT_EVENTS_URL_HEADER,
    resolveSkillReadReporter,
    SESSION_ID_HEADER,
    SKILL_READ_SOURCE
  } = await import("@simulatorlife/autodev-runtime/telemetry");
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
  const candidatePath = extractSkillReadPath(tool.toolName, tool.args);
  if (!candidatePath) return;
  const normalised = normaliseSkillReadPath(candidatePath);
  if (!normalised) return;
  const match = matchSkillReadTarget(normalised);
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
