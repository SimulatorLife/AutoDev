import { NextResponse } from "next/server.js";

/** The Console API's uncached JSON error envelope. */
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
