#!/usr/bin/env node
// Local stand-in for an OpenAI Responses provider, for AutoDev development only.
//
// Capture mode (no --turns): record exactly what Codex sends a provider and answer
// with a controlled error, so the Codex run ends without contacting any real API.
//
// Replay mode (--turns <file>): stream scripted SSE turns (one per request, the last
// one repeating) so the recorded follow-up request shows what Codex did with a
// provider's response shape.
//
// Credential-bearing headers are redacted before anything is written.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const REDACTED_HEADER_PATTERN = /authorization|api[-_]?key|cookie|token/i;

export function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, REDACTED_HEADER_PATTERN.test(name) ? "<redacted>" : value]));
}

export function sseBody(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export function startRecorder({ port = 0, record, turns = null }) {
  writeFileSync(record, "");
  let count = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      count += 1;
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = raw;
      try { body = JSON.parse(raw); } catch { /* keep the raw body */ }
      appendFileSync(record, `${JSON.stringify({ request: count, method: request.method, url: request.url, headers: redactHeaders(request.headers), body })}\n`);
      if (!turns) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "responses recorder: request recorded", type: "invalid_request_error", code: "capture_only" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(sseBody(turns[Math.min(count, turns.length) - 1]));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const record = argument("--record");
  if (!record) {
    process.stderr.write("usage: responses-recorder.mjs --record <file.jsonl> [--turns <turns.json>] [--port <port>]\n");
    process.exit(2);
  }
  const turnsFile = argument("--turns");
  const turns = turnsFile ? JSON.parse(readFileSync(turnsFile, "utf8")).turns : null;
  if (turns !== null && (!Array.isArray(turns) || turns.length === 0)) {
    process.stderr.write("--turns file must contain a non-empty \"turns\" array of SSE event arrays\n");
    process.exit(2);
  }
  const server = await startRecorder({ port: Number(argument("--port") ?? 0), record, turns });
  process.stderr.write(`responses recorder listening ${server.address().port}\n`);
}
