import type { IncomingMessage } from "node:http";

export type ControlApiJsonObjectResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly status: 400 | 413 | 415;
      readonly code: string;
      readonly message: string;
    };

const MAX_CONTROL_BODY_BYTES = 65_536;

/** Shared bounded JSON-object reader for Control API mutation routes. */
export async function readControlApiJsonObject(
  request: IncomingMessage
): Promise<ControlApiJsonObjectResult> {
  const rawContentType = request.headers["content-type"];
  const contentType = Array.isArray(rawContentType)
    ? rawContentType[0]
    : rawContentType;
  const separator = contentType?.indexOf(";") ?? -1;
  const mediaType =
    typeof contentType === "string"
      ? (separator === -1 ? contentType : contentType.slice(0, separator))
          .trim()
          .toLowerCase()
      : null;
  if (mediaType !== "application/json") {
    return {
      ok: false,
      status: 415,
      code: "autodev_control_api_content_type",
      message: "Control API mutations require application/json."
    };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_CONTROL_BODY_BYTES) {
      return {
        ok: false,
        status: 413,
        code: "autodev_control_api_payload_too_large",
        message: "Control API body exceeds 64 KiB."
      };
    }
    chunks.push(bytes);
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new TypeError("JSON object required");
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      status: 400,
      code: "autodev_control_api_bad_body",
      message: "Control API body must be a JSON object."
    };
  }
}
