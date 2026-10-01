#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Control API's fixed local identity; hooks cannot import Core under the layer rules.
const LOCAL_CONTROL_API_ACTOR = "autodev-local";
const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const ABSOLUTE_PATH_MAX = 4096;
const ENV_LINE_BREAK_PATTERN = /\r?\n/u;
const CONTROL_TOKEN_KEY = "AUTODEV_CONTROL_API_TOKEN=";
const EXPORTED_PREFIX = "export ";
const PORT_PATTERN = /^\d{1,5}$/u;

export interface CodexSessionEndCapture {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
}

export interface MemorySessionEndDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly readToken?: () => string | null;
  readonly fetchImpl?: typeof fetch;
  readonly stderr?: (message: string) => void;
}

/** Extract only the identifiers and local references required by the capture API. */
export function codexSessionEndCapture(
  value: unknown
): CodexSessionEndCapture | null {
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
  return { sessionId, transcriptPath, cwd };
}

/**
 * Best-effort SessionEnd callback. Memory storage is advisory; inability to
 * capture a historical transcript must never fail or delay the ended session.
 */
export function createMemorySessionEndHandler(
  dependencies: MemorySessionEndDependencies = {}
): (input?: Buffer | string) => Promise<number> {
  return async function captureSessionEnd(
    input: Buffer | string = readFileSync(0)
  ): Promise<number> {
    try {
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_HOOK_INPUT_BYTES)
        return 0;
      const event: unknown = JSON.parse(bytes.toString("utf8"));
      const capture = codexSessionEndCapture(event);
      if (!capture) return 0;

      const env = dependencies.env ?? process.env;
      const codexHome =
        env.CODEX_HOME?.trim() || path.join(env.HOME ?? homedir(), ".codex");
      const relativeTranscript = path.relative(
        path.resolve(codexHome, "sessions"),
        path.resolve(capture.transcriptPath)
      );
      if (
        !relativeTranscript ||
        relativeTranscript === ".." ||
        relativeTranscript.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeTranscript)
      ) {
        return 0;
      }
      const token = (
        dependencies.readToken ?? (() => readControlApiToken(env, codexHome))
      )();
      if (!token) return 0;
      const port = controlApiPort(env);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        await (dependencies.fetchImpl ?? globalThis.fetch)(
          `http://127.0.0.1:${port}/control/memory/capture`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "X-AutoDev-Actor": LOCAL_CONTROL_API_ACTOR,
              "Content-Type": "application/json",
              Accept: "application/json"
            },
            body: JSON.stringify(capture),
            signal: controller.signal
          }
        );
      } finally {
        clearTimeout(timer);
      }
    } catch {
      dependencies.stderr?.(
        "memory-session-end: capture unavailable; continuing\n"
      );
    }
    return 0;
  };
}

function readControlApiToken(
  env: NodeJS.ProcessEnv,
  codexHome: string
): string | null {
  const processToken = env.AUTODEV_CONTROL_API_TOKEN?.trim();
  if (processToken) return processToken;
  for (const file of [
    path.join(codexHome, ".env"),
    path.join(codexHome, "openlit-secrets.env")
  ]) {
    try {
      const contents = readFileSync(file, "utf8");
      for (const line of contents.split(ENV_LINE_BREAK_PATTERN)) {
        const entry = line.startsWith(EXPORTED_PREFIX)
          ? line.slice(EXPORTED_PREFIX.length)
          : line;
        if (!entry.startsWith(CONTROL_TOKEN_KEY)) continue;
        const rawValue = entry.slice(CONTROL_TOKEN_KEY.length).trim();
        const first = rawValue[0];
        const last = rawValue.at(-1);
        const quoted =
          rawValue.length >= 2 &&
          ((first === '"' && last === '"') || (first === "'" && last === "'"));
        const value = quoted ? rawValue.slice(1, -1) : rawValue;
        if (value) return value;
      }
    } catch {
      // The other credential source may still be available.
    }
  }
  return null;
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
