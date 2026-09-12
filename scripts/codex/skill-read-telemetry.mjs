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
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

import {
  AGENT_EVENTS_URL_HEADER,
  SESSION_ID_HEADER,
  SKILL_READ_SOURCE,
  resolveSkillReadReporter,
} from "./lib/agent-events.mjs";

const STATE_DIR = join(homedir(), ".codex", "run", "skill-read-telemetry");
const SEEN_KEYS_LIMIT = 4096;
const SEEN_VALUE_LIMIT = 4096;

const HOME = homedir();
const REPO_ROOT = process.env.AUTODEV_REPO_ROOT || resolve(join(import.meta.dirname, "..", ".."));
// Source roots whose SKILL.md reads count as skill activation telemetry.
// Mirrors the install-time contract in install-codex-integration.sh and is
// intentionally narrow: a path under a recognised root that ends in `SKILL.md`
// is the only positive signal we accept. Anything else -- symlinks that
// resolve outside the root, non-canonical locations, files that just happen
// to be named SKILL.md in a transitive include -- is ignored.
const SKILL_ROOTS = [
  join(HOME, ".agents", "skills"),
  join(HOME, ".codex", "skills"),
  join(HOME, "AutoDev", ".agents", "skills"),
  join(HOME, "AutoDev", "scripts", "codex", "skills"),
  join(REPO_ROOT, ".agents", "skills"),
  join(REPO_ROOT, "scripts", "codex", "skills"),
].filter((path) => existsSync(path));

const TOOL_NAME_KEYS = [ "tool_name", "toolName", "name" ];
const ARGUMENT_KEYS = [ "arguments", "args", "input", "params", "tool_input", "toolInput" ];
const SESSION_ID_KEYS = [ "session_id", "sessionId" ];
const TURN_ID_KEYS = [ "turn_id", "turnId" ];
const CODEX_SESSION_KEY = "x-codex-session-id";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function pickString(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickObject(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return null;
}

// The payload Codex sends uses different spellings across versions; this
// walks every plausible key and only accepts the payload if at least one tool
// name was present. A pre-tool hook that saw no tool name is a firehose we
// have no signal on, so we drop it instead of guessing.
function extractToolCall(payload) {
  const toolName = pickString(payload, TOOL_NAME_KEYS);
  if (!toolName) return null;
  const argsObject = pickObject(payload, ARGUMENT_KEYS) ?? {};
  return { toolName, args: argsObject };
}

// Extract a single path-like argument from a tool call. The shape varies
// across the tools Codex ships -- `read_file` uses `file_path`, `exec_command`
// carries the path inside `cmd` -- so we walk every plausible surface and
// return the first one that names a real file we can resolve. Returning null
// from the helper means "this tool call is not a SKILL.md read"; the hook
// drops it silently rather than logging anything.
function extractReadPath(argsObject) {
  const directKeys = [ "file_path", "filePath", "path", "filepath" ];
  for (const key of directKeys) {
    const value = argsObject[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const arrayKeys = [ "files", "paths", "file_paths" ];
  for (const key of arrayKeys) {
    const value = argsObject[key];
    if (Array.isArray(value) && value.length > 0) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (typeof first === "string") return first.trim();
    }
  }
  const cmd = argsObject.cmd ?? argsObject.command;
  if (typeof cmd === "string") {
    const match = matchExecCommandPath(cmd);
    if (match) return match;
  }
  return null;
}

// Look for a cat/head/sed/less/awk/grep/< redirect of an absolute path inside
// a free-form command. We deliberately do not parse the whole shell grammar --
// a path the user didn't quote as an absolute filename is not a SKILL.md read
// signal. The matches are bounded, so a long command cannot blow up the hook
// runtime.
function matchExecCommandPath(cmd) {
  if (cmd.length > 4096) return null;
  const re = /(?:^|\s)(?:cat|head|tail|less|more|sed\s+-n|awk|grep)(?:\s+\S+){0,8}\s+((?:\/|\~)[^\s'"]+)/g;
  let match;
  while ((match = re.exec(cmd)) !== null) {
    return match[1];
  }
  return null;
}

function normalisePath(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  let path = trimmed;
  if (path.startsWith("~")) path = join(HOME, path.slice(1));
  if (!isAbsolute(path)) path = resolve(path);
  return path;
}

// True when `path` resolves to a `<root>/<skill-name>/SKILL.md` for one of
// the approved roots, regardless of the platform's separator. Returning
// `{ skill }` rather than just true preserves the directory name as the
// canonical skill identifier the dashboard renders; we deliberately do not
// keep absolute paths in telemetry.
function matchSkillPath(path) {
  if (!path) return null;
  const normalised = path.replace(/[\\/]+/g, sep);
  for (const rootRaw of SKILL_ROOTS) {
    const root = rootRaw.replace(/[\\/]+/g, sep);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (!normalised.startsWith(rootWithSep)) continue;
    const relative = normalised.slice(root.length).replace(/^[\\/]+/, "");
    if (!relative.endsWith(`${sep}SKILL.md`) && !relative.endsWith("/SKILL.md")) continue;
    const segments = relative.split(/[\\/]/).filter(Boolean);
    if (segments.length !== 2) continue;
    const [ skill ] = segments;
    if (!skill || skill.includes("..")) continue;
    return { skill, root };
  }
  return null;
}

function hashKey(...parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

async function readSeenState(sessionId) {
  const path = join(STATE_DIR, `${sessionId}.json`);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return { path, value: parsed };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { path, value: { turns: {}, keys: [] } };
}

async function writeSeenState({ path, value }) {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

function pruneKeys(keys, keep) {
  const keepSet = new Set(keep);
  for (const key of keys) if (!keepSet.has(key)) keys.splice(keys.indexOf(key), 1);
  while (keys.length > SEEN_KEYS_LIMIT) keys.shift();
}

async function alreadyReported({ sessionId, turnId, skill, root }) {
  const state = await readSeenState(sessionId);
  const turn = state.value.turns?.[turnId];
  if (!turn) return false;
  const key = hashKey(skill, root);
  if (turn.has?.includes(key)) return true;
  return false;
}

async function markReported({ sessionId, turnId, skill, root, toolName }) {
  const state = await readSeenState(sessionId);
  if (!state.value.turns) state.value.turns = {};
  if (!state.value.keys) state.value.keys = [];
  if (!state.value.turns[turnId]) state.value.turns[turnId] = { has: [], tool: toolName };
  state.value.turns[turnId].has.push(hashKey(skill, root));
  state.value.keys.push(hashKey(sessionId, turnId, skill, root));
  pruneKeys(state.value.keys, state.value.keys.slice(-SEEN_VALUE_LIMIT));
  // Per-turn dedupe needs the key, but a stale turn should not leak disk.
  // Drop turn entries the router has not seen in the last 256 turns; LRU is
  // a bounded approximation, and the keys list retains the dedupe index.
  const turnKeys = Object.keys(state.value.turns);
  while (turnKeys.length > 64) {
    const drop = turnKeys.shift();
    delete state.value.turns[drop];
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

async function postSkillUsed({ sessionId, skill, root, toolName, turnId }) {
  const reporter = resolveSkillReadReporter({
    [ AGENT_EVENTS_URL_HEADER ]: resolveEventsUrl(),
    [ SESSION_ID_HEADER ]: sessionId,
  });
  if (!reporter) return;
  const eventId = `read:${sessionId}:${turnId}:${hashKey(skill, root).slice(0, 12)}`;
  // Fail-open: a post failure must not break the model turn. Best-effort by
  // design; reporter.post swallows transport errors and emits a bounded,
  // credential-free loss record so an operator can see it.
  await reporter.reportSkillUsed({
    skill,
    source: SKILL_READ_SOURCE,
    eventId,
  });
}

// Resolve the workspace CWD from payload so we can also write it to the
// session state for downstream consumers. Never forwarded in the post body.
function payloadCwd(payload) {
  const candidates = [
    payload?.cwd,
    payload?.working_directory,
    payload?.workingDirectory,
    payload?.workspace_cwd,
    payload?.repository_cwd,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function run() {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Hook receives malformed JSON: no-op rather than surfacing an error to
    // Codex. Telemetry must never fail a turn.
    process.exit(0);
  }
  const tool = extractToolCall(payload);
  if (!tool) return;
  if (!["read_file", "exec_command"].includes(tool.toolName)) return;
  const candidatePath = extractReadPath(tool.args);
  if (!candidatePath) return;
  const normalised = normalisePath(candidatePath);
  if (!normalised) return;
  const match = matchSkillPath(normalised)
  if (!match) return;
  const sessionId = pickString(payload, SESSION_ID_KEYS) ?? pickString(payload?.metadata ?? {}, SESSION_ID_KEYS) ?? payload?.[CODEX_SESSION_KEY] ?? null;
  if (!sessionId) return;
  const turnId = pickString(payload, TURN_ID_KEYS) ?? pickString(payload?.metadata ?? {}, TURN_ID_KEYS) ?? "no-turn";
  if (await alreadyReported({ sessionId, turnId, skill: match.skill, root: match.root })) return;
  await markReported({ sessionId, turnId, skill: match.skill, root: match.root, toolName: tool.toolName });
  await postSkillUsed({ sessionId, skill: match.skill, root: match.root, toolName: tool.toolName, turnId });
  payloadCwd(payload); // retained for symmetry; not forwarded in the post
}

run().catch(() => { /* fail-open by design */ }).finally(() => process.exit(0));
