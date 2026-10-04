/**
 * Request guards shared by Console mutation routes.
 *
 * Next.js builds `request.url` from the server's own bound hostname (for
 * example `localhost`), not from the host the browser addressed, so it can
 * neither prove nor refute that a request is same-origin. The browser-set
 * `Origin` and `Sec-Fetch-Site` headers are compared with the `Host` the
 * browser targeted (or the reverse proxy's `X-Forwarded-Host`) instead; a
 * cross-site page cannot forge any of them.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host =
    firstHeaderValue(request.headers.get("x-forwarded-host")) ||
    request.headers.get("host");
  if (
    !origin ||
    !host ||
    request.headers.get("sec-fetch-site") !== "same-origin"
  ) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function firstHeaderValue(value: string | null): string {
  if (!value) return "";
  const separator = value.indexOf(",");
  return (separator === -1 ? value : value.slice(0, separator)).trim();
}

/**
 * 303 to a Console path. The location stays relative so the browser resolves
 * it against the host it actually used, never the server's bound hostname.
 */
export function seeOther(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: path, "cache-control": "no-store" }
  });
}

/**
 * Reads a request body as strict UTF-8 up to `maxBytes`. Returns null when the
 * declared or streamed size exceeds the bound or the bytes are not UTF-8.
 */
export async function readBoundedRequestText(
  request: Request,
  maxBytes: number
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    /* eslint-disable no-await-in-loop -- sequential reads enforce the aggregate body cap. */
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
    /* eslint-enable no-await-in-loop */
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
