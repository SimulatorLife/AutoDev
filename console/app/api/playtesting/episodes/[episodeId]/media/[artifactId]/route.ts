import { Buffer } from "node:buffer";

import { type NextRequest, NextResponse } from "next/server.js";

import {
  controlApiFailureCode,
  readControlApiConfig
} from "../../../../../../../src/lib/server/control-api.ts";
import { fetchPlaytestingFrame } from "../../../../../../playtesting/playtesting-server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface FrameRouteContext {
  readonly params: Promise<{
    readonly episodeId: string;
    readonly artifactId: string;
  }>;
}

function errorResponse(
  status: number,
  code: string,
  message: string
): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    }
  );
}

export async function GET(
  request: NextRequest,
  context: FrameRouteContext
): Promise<Response> {
  const values = request.nextUrl.searchParams.getAll("workspaceId");
  if (values.length !== 1 || values[0]!.trim().length === 0) {
    return errorResponse(
      400,
      "autodev_console_playtesting_workspace_required",
      "A workspaceId is required to read a Playtesting frame."
    );
  }
  const config = readControlApiConfig();
  if (config === null) {
    return errorResponse(
      503,
      "autodev_control_api_not_configured",
      "The server-side AutoDev Control API is not configured."
    );
  }
  const { episodeId, artifactId } = await context.params;
  const result = await fetchPlaytestingFrame(
    values[0]!,
    episodeId,
    artifactId,
    config
  );
  if (result.kind !== "ok") {
    const status =
      result.kind === "unauthorized"
        ? result.status
        : result.kind === "http-error"
          ? result.status
          : result.kind === "unreachable"
            ? result.timedOut === true
              ? 504
              : 503
            : 502;
    return errorResponse(status, controlApiFailureCode(result), result.message);
  }
  return new Response(Buffer.from(result.data.bytes), {
    status: 200,
    headers: {
      "content-type": result.data.mediaType,
      "content-length": String(result.data.bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox"
    }
  });
}
