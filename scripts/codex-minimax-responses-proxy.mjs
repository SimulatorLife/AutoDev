#!/usr/bin/env node

/**
 * Responses compatibility proxy for the MiniMax API.
 *
 * Unlike the Claude, Antigravity, and Copilot bridges, this is a transparent
 * pass-through to a remote API rather than a local CLI gateway: it forwards the
 * parent's own Responses payload upstream and only re-expands the tool
 * namespaces MiniMax flattens. There is no delegated-role prompt to select, so
 * the router's local-only routing headers are stripped instead of honoured.
 */
import { createServer } from "node:http";

const host = process.env.MINIMAX_PROXY_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MINIMAX_PROXY_PORT ?? "18765", 10);
const upstreamBaseUrl = process.env.MINIMAX_PROXY_UPSTREAM_BASE_URL ?? "https://api.minimax.io";
// Hop-by-hop headers, plus the router's local-only routing headers. The turn
// metadata carries absolute workspace paths and git remote URLs, and the agent
// role is this router's own dispatch classification; both exist for local
// provider bridges and have no meaning to a remote API, so neither is sent
// upstream. Kept in sync with the router by tests/bridge-role.test.mjs.
const strippedRequestHeaders = [
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
  "x-codex-turn-metadata",
  "x-autodev-agent-role"
];
const flattenedNamespaces = [
  ["multi_agent_v1", "multi_agent_v1__"],
  ["collaboration", "collaboration__"],
  ["agents", "agents__"]
];

function rewrite(value) {
  if (Array.isArray(value)) {
    return value.map(rewrite);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = rewrite(child);
  }

  if (typeof result.name === "string" && (result.namespace === undefined || result.namespace === null)) {
    const match = flattenedNamespaces.find(([, prefix]) => result.name.startsWith(prefix));
    if (match) {
      result.namespace = match[0];
      result.name = result.name.slice(match[1].length);
    }
  }
  return result;
}

function rewriteSseLine(line) {
  const lineEnding = line.endsWith("\r") ? "\r" : "";
  const content = lineEnding ? line.slice(0, -1) : line;
  if (!content.startsWith("data:")) {
    return line;
  }
  const data = content.slice(5).trimStart();
  if (!data || data === "[DONE]") {
    return line;
  }
  try {
    return `data: ${JSON.stringify(rewrite(JSON.parse(data)))}${lineEnding}`;
  } catch {
    return line;
  }
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || strippedRequestHeaders.includes(name.toLowerCase())) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
}

function upstreamHeaders(response, upstream) {
  for (const [name, value] of upstream.headers) {
    if (["connection", "content-encoding", "content-length", "transfer-encoding"].includes(name.toLowerCase())) {
      continue;
    }
    response.setHeader(name, value);
  }
}

async function streamSse(body, response) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bufferedLine = "";

  const readNextChunk = async () => {
    const result = await reader.read();
    if (result.done) {
      bufferedLine += decoder.decode();
      if (bufferedLine) {
        response.write(rewriteSseLine(bufferedLine));
      }
      response.end();
      return;
    }

    bufferedLine += decoder.decode(result.value, { stream: true });
    const lines = bufferedLine.split("\n");
    bufferedLine = lines.pop() ?? "";
    for (const line of lines) {
      response.write(`${rewriteSseLine(line)}\n`);
    }
    await readNextChunk();
  };

  await readNextChunk();
}

function proxyError(response, error) {
  if (response.headersSent || response.destroyed) {
    return;
  }
  response.writeHead(502, { "content-type": "application/json" });
  response.end(JSON.stringify({
    error: {
      message: error instanceof Error ? error.message : "Upstream request failed.",
      type: "minimax_responses_proxy_error"
    }
  }));
}

async function forward(request, response) {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok\n");
    return;
  }

  const abortController = new AbortController();
  const abortUpstream = () => abortController.abort();
  request.once("aborted", abortUpstream);
  response.once("close", () => {
    if (!response.writableFinished) {
      abortUpstream();
    }
  });

  try {
    const upstream = await fetch(new URL(request.url ?? "/", upstreamBaseUrl), {
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await requestBody(request),
      headers: requestHeaders(request),
      method: request.method,
      signal: abortController.signal
    });
    upstreamHeaders(response, upstream);
    response.writeHead(upstream.status);
    if (upstream.body === null) {
      response.end();
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("text/event-stream")) {
      await streamSse(upstream.body, response);
      return;
    }

    const responseText = await upstream.text();
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        response.end(JSON.stringify(rewrite(JSON.parse(responseText))));
        return;
      } catch {
        // Preserve malformed/non-JSON upstream responses unchanged.
      }
    }
    response.end(responseText);
  } catch (error) {
    proxyError(response, error);
  } finally {
    request.removeListener("aborted", abortUpstream);
  }
}

createServer((request, response) => {
  void forward(request, response);
}).listen(port, host, () => {
  process.stderr.write(`MiniMax Responses proxy listening at http://${host}:${port}.\n`);
});
