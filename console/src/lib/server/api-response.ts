import { NextResponse } from "next/server.js";

import { controlApiFailureCode, type ControlApiResult } from "./control-api.ts";

/**
The Console API's uncached JSON error envelope.
*/
export function jsonErrorResponse(
  status: number,
  code: string,
  message: string
): NextResponse {
  return NextResponse.json(
    { kind: "error", code, message },
    { status, headers: { "cache-control": "no-store" } }
  );
}

/**
Project a typed Control API read without caching or losing failure status.
*/
export function controlApiReadResponse<T>(
  result: ControlApiResult<T>
): NextResponse {
  if (result.kind !== "ok") {
    return jsonErrorResponse(
      result.kind === "http-error" || result.kind === "unauthorized"
        ? result.status
        : result.kind === "unreachable"
          ? 503
          : 502,
      controlApiFailureCode(result),
      result.message
    );
  }
  return NextResponse.json(
    { kind: "ok", data: result.data },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}
