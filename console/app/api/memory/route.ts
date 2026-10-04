import { type NextRequest, NextResponse } from "next/server.js";

import {
  type ControlApiConfig,
  type ControlApiResult,
  promoteMemoryProcedureToSkill,
  readControlApiConfig,
  transitionMemoryRecord
} from "../../../src/lib/server/control-api.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface MemoryActionPayload {
  readonly action: string;
  readonly recordId: string;
  readonly workspaceId: string;
  readonly reason: string;
  readonly claim: string;
  readonly skillName: string;
  readonly isForm: boolean;
}

async function parsePayload(
  request: NextRequest
): Promise<MemoryActionPayload | null> {
  const contentType = request.headers.get("content-type") ?? "";
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");

  if (isForm) {
    const formData = await request.formData();
    return {
      action: String(formData.get("action") ?? "").trim(),
      recordId: String(formData.get("recordId") ?? "").trim(),
      workspaceId:
        String(formData.get("workspaceId") ?? "").trim() ||
        "SimulatorLife/AutoDev",
      reason: String(formData.get("reason") ?? "").trim(),
      claim: String(formData.get("claim") ?? "").trim(),
      skillName: String(formData.get("skillName") ?? "").trim(),
      isForm: true
    };
  }

  try {
    const json = (await request.json()) as Record<string, unknown>;
    return {
      action: String(json.action ?? "").trim(),
      recordId: String(json.recordId ?? "").trim(),
      workspaceId:
        String(json.workspaceId ?? "").trim() || "SimulatorLife/AutoDev",
      reason: String(json.reason ?? "").trim(),
      claim: String(json.claim ?? "").trim(),
      skillName: String(json.skillName ?? "").trim(),
      isForm: false
    };
  } catch {
    return null;
  }
}

function executeAction(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): Promise<ControlApiResult<unknown>> | null {
  const { action, recordId, workspaceId, reason, claim, skillName } = payload;
  switch (action) {
    case "verify": {
      return transitionMemoryRecord(
        recordId,
        "verify",
        { workspaceId, reason: reason || "Operator manual verification." },
        config
      );
    }
    case "invalidate": {
      return transitionMemoryRecord(
        recordId,
        "invalidate",
        { workspaceId, reason: reason || "Operator invalidation." },
        config
      );
    }
    case "revise": {
      if (!claim) return null;
      return transitionMemoryRecord(
        recordId,
        "revise",
        { workspaceId, claim, reason: reason || "Operator revision." },
        config
      );
    }
    case "promote-skill": {
      const name = skillName || `memory-proc-${recordId.slice(0, 8)}`;
      return promoteMemoryProcedureToSkill(
        {
          workspaceId,
          memoryId: recordId,
          skillName: name,
          description: `Promoted from durable procedure memory ${recordId}`
        },
        config
      );
    }
    default: {
      return null;
    }
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = readControlApiConfig();
  if (!config) {
    return NextResponse.json(
      { error: "Control API configuration or token is missing" },
      { status: 503 }
    );
  }

  const payload = await parsePayload(request);
  if (!payload || !payload.recordId) {
    return NextResponse.json(
      { error: "Invalid request payload or missing recordId" },
      { status: 400 }
    );
  }

  const result = await executeAction(payload, config);
  if (!result) {
    return NextResponse.json(
      { error: `Unsupported or incomplete action: ${payload.action}` },
      { status: 400 }
    );
  }

  if (result.kind !== "ok") {
    const status = "status" in result ? result.status : 500;
    return NextResponse.json({ error: result }, { status });
  }

  if (payload.isForm) {
    const redirectUrl = new URL("/memory", request.url);
    redirectUrl.searchParams.set("tab", "records");
    redirectUrl.searchParams.set("workspaceId", payload.workspaceId);
    redirectUrl.searchParams.set("recordId", payload.recordId);
    return NextResponse.redirect(redirectUrl, { status: 303 });
  }

  return NextResponse.json({
    success: true,
    action: payload.action,
    recordId: payload.recordId
  });
}
