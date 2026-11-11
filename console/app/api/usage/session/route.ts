/** Same-origin, server-only exact-session Usage trace lookup. */

import {
  safeAutoDevSessionId,
  type UsageSessionEvidence,
  type UsageSessionQuerySelection
} from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import { isSameOriginMutation } from "../../../../src/lib/server/form-mutation.ts";
import { loadOpenLITSessionUsage } from "../../../../src/lib/server/openlit-usage.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 16_384;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_SESSION_LOOKBACK_DAYS = 90;
const PRESET_RANGES = new Set(["24H", "7D", "1M", "3M"]);
const SESSION_LOOKUP_SCHEMA = "autodev-console-session-usage-v1" as const;

type SessionLookupReplyBody =
  | { readonly kind: "ok"; readonly data: UsageSessionEvidence }
  | {
      readonly kind: "invalid-session-id" | "unavailable" | "invalid-response";
    };

function json(status: number, body: SessionLookupReplyBody): NextResponse {
  return NextResponse.json(
    { schema: SESSION_LOOKUP_SCHEMA, ...body },
    {
      status,
      headers: { "Cache-Control": "no-store" }
    }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDate(
  value: unknown
): { readonly text: string; readonly epoch: number } | null {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return null;
  const epoch = Date.parse(value + "T00:00:00.000Z");
  if (
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString().slice(0, 10) !== value
  )
    return null;
  return { text: value, epoch };
}

function sessionSelection(value: unknown): UsageSessionQuerySelection | null {
  if (
    !isRecord(value) ||
    typeof value.range !== "string" ||
    Object.keys(value).some((key) => key !== "range" && key !== "customRange")
  ) {
    return null;
  }
  if (PRESET_RANGES.has(value.range)) {
    if (Object.hasOwn(value, "customRange")) return null;
    return {
      range: value.range as Exclude<
        UsageSessionQuerySelection["range"],
        "CUSTOM"
      >
    };
  }
  if (value.range !== "CUSTOM" || !isRecord(value.customRange)) return null;
  if (
    Object.keys(value).some(
      (key) => key !== "range" && key !== "customRange"
    ) ||
    Object.keys(value.customRange).some(
      (key) => key !== "startDate" && key !== "endDate"
    )
  )
    return null;
  const start = parseDate(value.customRange.startDate);
  const end = parseDate(value.customRange.endDate);
  if (!start || !end || end.epoch < start.epoch) return null;
  const days = Math.floor((end.epoch - start.epoch) / 86_400_000) + 1;
  if (days > MAX_SESSION_LOOKBACK_DAYS) return null;
  return {
    range: "CUSTOM",
    customRange: { startDate: start.text, endDate: end.text }
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // This read uses a server-only Usage credential and can query exact session
  // traces, so the browser entry point is restricted to its own origin.
  if (!isSameOriginMutation(request)) return json(403, { kind: "unavailable" });
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return json(415, { kind: "unavailable" });
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return json(413, { kind: "unavailable" });
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES)
      return json(413, { kind: "unavailable" });
    body = JSON.parse(text);
  } catch {
    return json(400, { kind: "unavailable" });
  }
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== "sessionId" && key !== "selection")
  ) {
    return json(400, { kind: "unavailable" });
  }
  const sessionId = safeAutoDevSessionId(body.sessionId);
  const selection = sessionSelection(body.selection);
  if (!sessionId) return json(400, { kind: "invalid-session-id" });
  if (!selection) return json(400, { kind: "unavailable" });

  const result = await loadOpenLITSessionUsage(sessionId, selection);
  switch (result.kind) {
    case "ok": {
      return json(200, { kind: "ok", data: result.data });
    }
    case "invalid-session-id": {
      return json(400, { kind: "invalid-session-id" });
    }
    case "not-configured":
    case "unavailable": {
      return json(503, { kind: "unavailable" });
    }
    case "invalid-response": {
      return json(502, { kind: "invalid-response" });
    }
    case "unauthorized":
    case "http-error": {
      return json(502, { kind: "unavailable" });
    }
  }
}
