#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Control API's fixed local identity; hooks cannot import Core under the layer rules.
const LOCAL_CONTROL_API_ACTOR = "autodev-local";
const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_CODE_PROVIDER = "claude-code" as const;
const CONTROL_TOKEN_ENV_FILES = [".env", "openlit-secrets.env"] as const;
const ABSOLUTE_PATH_MAX = 4096;
const ENV_LINE_BREAK_PATTERN = /\r?\n/u;
const CONTROL_TOKEN_KEY = "AUTODEV_CONTROL_API_TOKEN=";
const EXPORTED_PREFIX = "export ";
const PORT_PATTERN = /^\d{1,5}$/u;

export type SessionEndProvider =
  typeof CODEX_PROVIDER | typeof CLAUDE_CODE_PROVIDER;

export interface MemorySessionEndCapture {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
  readonly provider: SessionEndProvider;
}

export interface MemorySessionEndDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly readToken?: () => string | null;
  readonly fetchImpl?: typeof fetch;
}

/** Extract only the identifiers and local references required by the capture API. */
export function sessionEndCapture(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env
): MemorySessionEndCapture | null {
  if (!isRecord(value) || value.hook_event_name !== "SessionEnd") return null;
  const sessionId = value.session_id;
  const transcriptPath = value.transcript_path;
  const cwd = value.cwd;
  if (
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId) ||
    typeof transcriptPath !== "string" ||
    !path.isAbsolute(transcriptPath) ||
    transcriptPath.length > ABSOLUTE_PATH_MAX ||
    typeof cwd !== "string" ||
    !path.isAbsolute(cwd) ||
    cwd.length > ABSOLUTE_PATH_MAX
  ) {
    return null;
  }
  // The provider is operator-controlled, not caller-controlled. Both
  // Codex CLI and Claude Code emit a SessionEnd payload with the same
  // shape, so we only switch the routing when the runtime was launched
  // with an explicit provider tag.
  const provider: SessionEndProvider = sessionEndProvider(env);
  return { sessionId, transcriptPath, cwd, provider };
}

/**
 * Best-effort SessionEnd callback. Memory storage is advisory; inability to
 * capture a historical transcript must never fail or delay the ended session.
 *
 * Failing open still has to be visible: this hook's entire contract is to
 * succeed quietly, so a capture that silently does nothing is
 * indistinguishable from one that correctly declined. The diagnostic is
 * written straight to stderr rather than through an injected sink. An
 * injectable sink here had zero implementations and was optional-chained, so
 * in the field the message was dropped outright.
 *
 * The write is deliberately inline rather than routed through
 * `shared/output.ts`: this file is materialized on its own into `CODEX_HOME`
 * and executed there, where the Runtime package does not resolve. That is the
 * same reason it carries its own copy of the Control API actor constant, and
 * it matches how `session-start.ts` reports.
 */
export function createMemorySessionEndHandler(
  dependencies: MemorySessionEndDependencies = {}
): (input?: Buffer | string) => Promise<number> {
  return async function captureSessionEnd(
    input: Buffer | string = readFileSync(0)
  ): Promise<number> {
    try {
      await postSessionEndCapture(input, dependencies);
    } catch {
      process.stderr.write(
        "memory-session-end: capture unavailable; continuing\n"
      );
    }
    return 0;
  };
}

async function postSessionEndCapture(
  input: Buffer | string,
  dependencies: MemorySessionEndDependencies
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const capture = parseSessionEndCapture(input, env);
  if (!capture) return;
  const token = (dependencies.readToken ?? (() => readControlApiToken(env)))();
  if (!token) return;

  const port = controlApiPort(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const endpoint =
      capture.provider === CLAUDE_CODE_PROVIDER
        ? `/control/memory/claude-code/capture`
        : `/control/memory/capture`;
    await (dependencies.fetchImpl ?? globalThis.fetch)(
      `http://127.0.0.1:${port}${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-AutoDev-Actor": LOCAL_CONTROL_API_ACTOR,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          sessionId: capture.sessionId,
          transcriptPath: capture.transcriptPath,
          cwd: capture.cwd
        }),
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseSessionEndCapture(
  input: Buffer | string,
  env: NodeJS.ProcessEnv
): MemorySessionEndCapture | null {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_HOOK_INPUT_BYTES)
    return null;
  const event: unknown = JSON.parse(bytes.toString("utf8"));
  const capture = sessionEndCapture(event, env);
  if (!capture || !isTranscriptPathAllowed(capture, env)) return null;
  return capture;
}

function isTranscriptPathAllowed(
  capture: MemorySessionEndCapture,
  env: NodeJS.ProcessEnv
): boolean {
  if (capture.provider === CLAUDE_CODE_PROVIDER) return true;
  const codexHome =
    env.CODEX_HOME?.trim() || path.join(env.HOME ?? homedir(), ".codex");
  const relativeTranscript = path.relative(
    path.resolve(codexHome, "sessions"),
    path.resolve(capture.transcriptPath)
  );
  return Boolean(
    relativeTranscript &&
    relativeTranscript !== ".." &&
    !relativeTranscript.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeTranscript)
  );
}

function readControlApiToken(env: NodeJS.ProcessEnv): string | null {
  const processToken = env.AUTODEV_CONTROL_API_TOKEN?.trim();
  if (processToken) return processToken;
  for (const file of controlApiTokenFiles(env)) {
    const token = tokenFromFile(file);
    if (token) return token;
  }
  return null;
}

function controlApiTokenFiles(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const claudeHome = env.CLAUDE_HOME?.trim() || path.join(home, ".claude");
  const homes =
    sessionEndProvider(env) === CLAUDE_CODE_PROVIDER
      ? [claudeHome, codexHome]
      : [codexHome, claudeHome];
  return homes.flatMap((directory) =>
    CONTROL_TOKEN_ENV_FILES.map((filename) => path.join(directory, filename))
  );
}

function tokenFromFile(filePath: string): string | null {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  for (const line of contents.split(ENV_LINE_BREAK_PATTERN)) {
    const token = parseControlApiToken(line);
    if (token) return token;
  }
  return null;
}

function parseControlApiToken(line: string): string | null {
  const entry = line.startsWith(EXPORTED_PREFIX)
    ? line.slice(EXPORTED_PREFIX.length)
    : line;
  if (!entry.startsWith(CONTROL_TOKEN_KEY)) return null;
  const rawValue = entry.slice(CONTROL_TOKEN_KEY.length).trim();
  const first = rawValue[0];
  const last = rawValue.at(-1);
  const quoted =
    rawValue.length >= 2 &&
    ((first === '"' && last === '"') || (first === "'" && last === "'"));
  const value = quoted ? rawValue.slice(1, -1) : rawValue;
  return value || null;
}

function sessionEndProvider(env: NodeJS.ProcessEnv): SessionEndProvider {
  return env.AUTODEV_MEMORY_HOOK_PROVIDER === CLAUDE_CODE_PROVIDER
    ? CLAUDE_CODE_PROVIDER
    : CODEX_PROVIDER;
}

function controlApiPort(env: NodeJS.ProcessEnv): number {
  const raw = env.AUTODEV_CONTROL_API_LISTEN_PORT?.trim();
  if (!raw) return 4101;
  if (!PORT_PATTERN.test(raw)) return 4101;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 4101;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const runMemorySessionEnd = createMemorySessionEndHandler();

function isEntrypoint(): boolean {
  const argument = process.argv[1];
  if (!argument) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    // macOS resolves /tmp to /private/tmp in import.meta.url. Compare real
    // paths so the materialized CODEX_HOME copy still runs from either path.
    return realpathSync(argument) === realpathSync(modulePath);
  } catch {
    return path.resolve(argument) === path.resolve(modulePath);
  }
}

if (isEntrypoint()) {
  process.exitCode = await runMemorySessionEnd();
}
