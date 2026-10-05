/** Same-origin and bounded form parsing shared by server-side mutation routes. */

const CONTENT_LENGTH_PATTERN = /^\d+$/u;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsedOrigin = new URL(origin);
    return (
      parsedOrigin.origin === origin &&
      parsedOrigin.host.toLowerCase() === host.toLowerCase() &&
      request.headers.get("sec-fetch-site") === "same-origin"
    );
  } catch {
    return false;
  }
}

export async function readStrictUrlEncodedFormBody(
  request: Request,
  maxBytes: number
): Promise<URLSearchParams | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  const contentType = (request.headers.get("content-type") ?? "")
    .trim()
    .toLowerCase();
  if (
    contentType !== FORM_CONTENT_TYPE &&
    contentType !== `${FORM_CONTENT_TYPE}; charset=utf-8` &&
    contentType !== `${FORM_CONTENT_TYPE};charset=utf-8`
  ) {
    return null;
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!CONTENT_LENGTH_PATTERN.test(contentLength)) return null;
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      return null;
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      // Read sequentially so the stream cap also bounds memory.
      // eslint-disable-next-line no-await-in-loop -- Sequential reads enforce the streamed byte cap.
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maxBytes) {
        // eslint-disable-next-line no-await-in-loop -- Cancel the same bounded stream before releasing its reader.
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0) return null;
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    return null;
  }
}
