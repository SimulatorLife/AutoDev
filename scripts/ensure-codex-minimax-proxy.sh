#!/usr/bin/env bash
# Ensure the persistent MiniMax Responses compatibility proxy is available.
# This script is safe to call repeatedly from Codex lifecycle hooks.

set -euo pipefail

daemon_mode=0
if [[ "${1:-}" == "--daemon" ]]; then
  daemon_mode=1
fi

# Codex command hooks receive the active session/subagent model via stdin.
# Do nothing unless this invocation is using the MiniMax model.
minimax_model="${CODEX_MINIMAX_MODEL:-MiniMax-M3}"

active_model="$(
  node -e '
    const fs = require("node:fs");

    try {
      const input = JSON.parse(fs.readFileSync(0, "utf8"));
      const model = typeof input.model === "string" ? input.model : "";
      process.stdout.write(model);
    } catch {
      process.stdout.write("");
    }
  '
)"

if [[ "$daemon_mode" != 1 && "$active_model" != "$minimax_model" ]]; then
  exit 0
fi

proxy_host="${CODEX_MINIMAX_PROXY_HOST:-127.0.0.1}"
proxy_port="${CODEX_MINIMAX_PROXY_PORT:-18765}"
proxy_url="http://${proxy_host}:${proxy_port}"
proxy_log="${CODEX_MINIMAX_PROXY_LOG:-${TMPDIR:-/tmp}/codex-minimax-proxy-${proxy_port}.log}"
proxy_pid_file="${CODEX_MINIMAX_PROXY_PID_FILE:-${TMPDIR:-/tmp}/codex-minimax-proxy-${proxy_port}.pid}"
upstream_base_url="${CODEX_MINIMAX_UPSTREAM_URL:-https://api.minimax.io}"

proxy_is_ready() {
  curl --silent --fail --max-time 1 "${proxy_url}/health" >/dev/null 2>&1
}

if proxy_is_ready; then
  exit 0
fi

if [[ "$daemon_mode" != 1 ]]; then
  launch_domain="gui/$(id -u)"
  launch_label="com.codex.minimax-proxy"
  # The repository lives under Desktop, where launchd can be denied access by
  # macOS privacy controls. Start the canonical versioned script directly from
  # the Codex lifecycle process instead.
  launchctl bootout "$launch_domain/$launch_label" >/dev/null 2>&1 || true
  direct_launcher="$HOME/.codex/hooks/ensure-codex-minimax-proxy.sh"
  if [[ -L "$direct_launcher" ]]; then direct_launcher="$(readlink "$direct_launcher")"; fi
  /bin/bash "$direct_launcher" --daemon
  for _ in {1..50}; do
    if proxy_is_ready; then
      exit 0
    fi
    sleep 0.1
  done

  echo "MiniMax compatibility proxy failed to start." >&2
  echo "Proxy log: $proxy_log" >&2
  cat "$proxy_log" >&2 2>/dev/null || true
  exit 1
fi

mkdir -p "$(dirname -- "$proxy_log")" "$(dirname -- "$proxy_pid_file")"

MINIMAX_PROXY_HOST="$proxy_host" \
MINIMAX_PROXY_PORT="$proxy_port" \
MINIMAX_PROXY_UPSTREAM_BASE_URL="$upstream_base_url" \
nohup node --input-type=module \
  >"$proxy_log" 2>&1 \
  </dev/null <<'NODE' &
import { createServer } from "node:http";

const host = process.env.MINIMAX_PROXY_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MINIMAX_PROXY_PORT ?? "18765", 10);
const upstreamBaseUrl = process.env.MINIMAX_PROXY_UPSTREAM_BASE_URL ?? "https://api.minimax.io";
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
    if (
      value === undefined ||
      ["connection", "content-length", "host", "transfer-encoding"].includes(name.toLowerCase())
    ) {
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
NODE
printf '%s\n' "$!" >"$proxy_pid_file"

if [[ "$daemon_mode" == 1 ]]; then
  wait "$!"
  exit $?
fi

for _ in {1..50}; do
  if proxy_is_ready; then
    exit 0
  fi
  sleep 0.1
done

echo "MiniMax compatibility proxy failed to start." >&2
echo "Proxy log: $proxy_log" >&2
cat "$proxy_log" >&2 2>/dev/null || true
exit 1
