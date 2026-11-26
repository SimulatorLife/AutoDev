/*
HTTP endpoints for ACP / `xacpx` session orchestration on the AutoDev Router.

Routes:
- `GET  /v1/acp/sessions`
- `POST /v1/acp/sessions`
- `POST /v1/acp/sessions/:sessionId/prompt`
- `POST /v1/acp/sessions/:sessionId/cancel`
- `DELETE /v1/acp/sessions/:sessionId`
*/

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { isRecord } from "@simulatorlife/autodev-core";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import {
  type PlanSessionRequest,
  XacpxSessionManager
} from "@simulatorlife/autodev-runtime/xacpx/manager";

const MAX_BODY_BYTES = 1_048_576;
const METHOD_NOT_ALLOWED_ERROR = "Method not allowed";
const ACP_SESSION_PROMPT_ROUTE = /^\/v1\/acp\/sessions\/([^/]+)\/prompt$/u;
const ACP_SESSION_CANCEL_ROUTE = /^\/v1\/acp\/sessions\/([^/]+)\/cancel$/u;
const ACP_SESSION_ITEM_ROUTE = /^\/v1\/acp\/sessions\/([^/]+)$/u;

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    connection: "close"
  });
  response.end(encoded);
}

async function readJsonObject(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += chunkBuffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body exceeds 1 MiB limit.");
    }
    chunks.push(chunkBuffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed;
}

function optionalTrimmedField(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const raw = body[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

async function handleSessionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  manager: XacpxSessionManager
): Promise<void> {
  if (request.method === "GET") {
    writeJson(response, 200, { sessions: manager.listPinnedSessions() });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: METHOD_NOT_ALLOWED_ERROR });
    return;
  }
  try {
    const body = await readJsonObject(request);
    const role = optionalTrimmedField(body, "role") ?? "";
    const cwd = optionalTrimmedField(body, "cwd") ?? "";
    const promptOrTask =
      typeof body.promptOrTask === "string"
        ? body.promptOrTask
        : typeof body.prompt === "string"
          ? body.prompt
          : "";
    if (!role || !cwd || !promptOrTask) {
      writeJson(response, 400, {
        error: "Fields `role`, `cwd`, and `promptOrTask` are required."
      });
      return;
    }
    const repository = optionalTrimmedField(body, "repository");
    const parentSessionId = optionalTrimmedField(body, "parentSessionId");
    const planRequest: PlanSessionRequest = {
      sessionId: optionalTrimmedField(body, "sessionId") ?? randomUUID(),
      role,
      cwd,
      systemPrompt:
        typeof body.systemPrompt === "string" ? body.systemPrompt : "",
      promptOrTask,
      ...(repository && { repository }),
      ...(parentSessionId && { parentSessionId })
    };
    const result = await manager.executeTurn(planRequest);
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(response, 400, { error: errorMessage(error) });
  }
}

async function handleSessionPromptRoute(
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
  manager: XacpxSessionManager
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: METHOD_NOT_ALLOWED_ERROR });
    return;
  }
  try {
    const body = await readJsonObject(request);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt) {
      writeJson(response, 400, { error: "Field `prompt` is required." });
      return;
    }
    const result = await manager.promptSession(sessionId, prompt);
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(response, 400, { error: errorMessage(error) });
  }
}

export const SHARED_XACPX_SESSION_MANAGER = new XacpxSessionManager();

export async function didHandleAcpRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  manager: XacpxSessionManager = SHARED_XACPX_SESSION_MANAGER
): Promise<boolean> {
  if (pathname === "/v1/acp/sessions") {
    await handleSessionsCollection(request, response, manager);
    return true;
  }

  const promptMatch = ACP_SESSION_PROMPT_ROUTE.exec(pathname);
  if (promptMatch) {
    const sessionId = decodeURIComponent(promptMatch[1] ?? "");
    await handleSessionPromptRoute(request, response, sessionId, manager);
    return true;
  }

  const cancelMatch = ACP_SESSION_CANCEL_ROUTE.exec(pathname);
  if (cancelMatch) {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: METHOD_NOT_ALLOWED_ERROR });
      return true;
    }
    const sessionId = decodeURIComponent(cancelMatch[1] ?? "");
    const cancelled = await manager.cancelSession(sessionId);
    writeJson(response, cancelled ? 200 : 404, { sessionId, cancelled });
    return true;
  }

  const sessionMatch = ACP_SESSION_ITEM_ROUTE.exec(pathname);
  if (!sessionMatch) return false;

  const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
  if (request.method === "GET") {
    const session = manager.getPinnedSession(sessionId);
    if (!session) {
      writeJson(response, 404, { error: `Unknown session '${sessionId}'.` });
      return true;
    }
    writeJson(response, 200, { session });
    return true;
  }
  if (request.method === "DELETE") {
    const closed = await manager.closeSession(sessionId);
    writeJson(response, closed ? 200 : 404, { sessionId, closed });
    return true;
  }
  writeJson(response, 405, { error: METHOD_NOT_ALLOWED_ERROR });
  return true;
}
