/**
 * Same-origin boundary for previewing a canonical prompt source.
 *
 * The preview answers "what will this source look like" without writing
 * anything: it parses the operator's unsaved text with Data's canonical
 * RuleSync parser and hands back the body the source carries. Nothing here
 * touches the canonical file, the projection or the Runtime -- a preview that
 * wrote would be a save, and a save is the operator's separate, deliberate
 * act.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import { isSameOriginMutation } from "../../../../src/lib/server/form-mutation.ts";
import { previewPromptSource } from "../../../../src/lib/server/prompt-preview.ts";

const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_BODY_BYTES = 160_000;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PreviewPayload {
  readonly name: string;
  readonly content: string;
}

/**
 * The body this route answers, read within a bound.
 *
 * The source is the operator's own edit and can be a whole prompt, so the
 * bound is the one the save path uses for the same text. A body past it is
 * refused rather than truncated: a truncated source would be previewed as a
 * different source.
 */
async function readPayload(request: Request): Promise<PreviewPayload | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) return null;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { name, content } = body as Record<string, unknown>;
  if (typeof name !== "string" || typeof content !== "string") return null;
  if (content.length > MAX_BODY_BYTES) return null;
  return { name, content };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "Prompt preview requires a same-origin request." },
      { status: 403 }
    );
  }
  const payload = await readPayload(request);
  if (payload === null) {
    return NextResponse.json(
      { error: "Prompt preview needs a command name and its source." },
      { status: 400 }
    );
  }
  if (!COMMAND_NAME_PATTERN.test(payload.name)) {
    return NextResponse.json(
      { error: "Prompt preview needs a command name." },
      { status: 400 }
    );
  }
  return NextResponse.json(previewPromptSource(payload.name, payload.content));
}
