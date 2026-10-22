/**
 * Same-origin boundary for writing one MCP server's canonical declaration.
 *
 * The route receives the operator's edit, validates its same-origin browser
 * context, and forwards a typed PATCH to Runtime using the server-side Control
 * API credential. The browser never receives that credential and never
 * bypasses Runtime: the declaration is written by the Runtime, which applies
 * the projection and observes what it published.
 *
 * Only POST is exported. A refused write answers with the Runtime's reason --
 * a conflict, a refused declaration or a failed projection are different
 * facts, and the operator is told which one happened.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  patchMcpServer,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import { isSameOriginMutation } from "../../../../src/lib/server/form-mutation.ts";

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_BODY_BYTES = 16_384;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The launch keys one write carries.
 *
 * A key the operator cleared is `null`, which removes it from the declaration.
 * The keys are read strictly: a value of another type is a body this route
 * does not understand, and forwarding it would ask the Runtime to write
 * something the operator did not type.
 */
function readLaunch(value: unknown): {
  readonly command: string | null;
  readonly args: readonly string[] | null;
  readonly cwd: string | null;
  readonly url: string | null;
  readonly bearerTokenEnvVar: string | null;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const launch = value as Record<string, unknown>;
  const text = (
    key: string
  ):
    | { readonly ok: true; readonly value: string | null }
    | { readonly ok: false } => {
    const raw = launch[key];
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== "string") return { ok: false };
    return { ok: true, value: raw };
  };
  const command = text("command");
  const url = text("url");
  const cwd = text("cwd");
  const bearerTokenEnvVar = text("bearerTokenEnvVar");
  if (!command.ok || !url.ok || !cwd.ok || !bearerTokenEnvVar.ok) return null;
  const args = launch.args;
  if (
    args !== null &&
    (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
  ) {
    return null;
  }
  return {
    command: command.value,
    args: args as readonly string[] | null,
    url: url.value,
    cwd: cwd.value,
    bearerTokenEnvVar: bearerTokenEnvVar.value
  };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ name: string }> }
): Promise<NextResponse> {
  const { name } = await context.params;
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return NextResponse.json(
      { error: "The MCP server name is not a usable one." },
      { status: 400 }
    );
  }
  if (!isSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "Writing the MCP declaration requires a same-origin request." },
      { status: 403 }
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "The MCP launch configuration is too large." },
        { status: 413 }
      );
    }
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "The MCP launch configuration could not be read." },
      { status: 400 }
    );
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { error: "The MCP launch configuration could not be read." },
      { status: 400 }
    );
  }
  const { expectedRevision, launch } = body as Record<string, unknown>;
  if (
    typeof expectedRevision !== "string" ||
    !REVISION_PATTERN.test(expectedRevision)
  ) {
    return NextResponse.json(
      { error: "The write needs the revision the declaration was read at." },
      { status: 400 }
    );
  }
  const parsed = readLaunch(launch);
  if (parsed === null) {
    return NextResponse.json(
      { error: "The MCP launch configuration is not a usable one." },
      { status: 400 }
    );
  }

  const config = readControlApiConfig();
  if (!config) {
    return NextResponse.json(
      { error: "The Control API credential is not available." },
      { status: 503 }
    );
  }
  const result = await patchMcpServer(
    name,
    { expectedRevision, launch: parsed },
    config
  );
  if (result.kind === "ok") {
    return NextResponse.json({ ok: true, data: result.data });
  }
  return NextResponse.json(
    { error: result.message },
    { status: result.kind === "http-error" ? result.status : 502 }
  );
}
