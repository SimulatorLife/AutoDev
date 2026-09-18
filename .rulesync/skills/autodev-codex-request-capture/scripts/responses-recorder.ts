#!/usr/bin/env node
// Local stand-in for an OpenAI Responses provider, for AutoDev development only.
// Capture mode records requests; replay mode streams scripted SSE turns.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

export const REDACTED_HEADER_PATTERN = /authorization|api[-_]?key|cookie|token/iu;
export type JsonRecord = Record<string, unknown>;
export interface SseEvent extends JsonRecord { readonly type: string }
export interface RecorderOptions { readonly port?: number; readonly record: string; readonly turns?: readonly SseEvent[][] | null }

export function redactHeaders(headers: IncomingHttpHeaders | Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, REDACTED_HEADER_PATTERN.test(name) ? '<redacted>' : value]));
}

export function sseBody(events: readonly SseEvent[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

export function startRecorder({ port = 0, record, turns = null }: RecorderOptions): Promise<Server> {
  writeFileSync(record, '');
  let count = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      count += 1;
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try { body = JSON.parse(raw) as unknown; } catch { /* keep raw body */ }
      appendFileSync(record, `${JSON.stringify({ request: count, method: request.method, url: request.url, headers: redactHeaders(request.headers), body })}\n`);
      if (!turns) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'responses recorder: request recorded', type: 'invalid_request_error', code: 'capture_only' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(sseBody(turns[Math.min(count, turns.length) - 1] ?? []));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const record = argument('--record');
  if (!record) {
    process.stderr.write('usage: responses-recorder.ts --record <file.jsonl> [--turns <turns.json>] [--port <port>]\n');
    process.exit(2);
  }
  const turnsFile = argument('--turns');
  const turnsValue: unknown = turnsFile ? JSON.parse(readFileSync(turnsFile, 'utf8')) : null;
  const turns = turnsValue && typeof turnsValue === 'object' && !Array.isArray(turnsValue) ? (turnsValue as { turns?: unknown }).turns : null;
  if (turns !== null && (!Array.isArray(turns) || turns.length === 0)) {
    process.stderr.write('--turns file must contain a non-empty "turns" array of SSE event arrays\n');
    process.exit(2);
  }
  const server = await startRecorder({ port: Number(argument('--port') ?? 0), record, turns: turns as SseEvent[][] | null });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  process.stderr.write(`responses recorder listening ${port}\n`);
}
