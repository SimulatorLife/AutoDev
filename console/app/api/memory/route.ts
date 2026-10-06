import { type NextRequest, NextResponse } from "next/server.js";

import {
  type ControlApiConfig,
  type ControlApiResult,
  promoteMemoryProcedureToSkill,
  purgeMemoryExperience,
  readControlApiConfig,
  transitionMemoryRecord
} from "../../../src/lib/server/control-api.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface MemoryActionPayload {
  readonly action: string;
  readonly recordId: string;
  readonly experienceId: string;
  readonly workspaceId: string;
  readonly reason: string;
  readonly claim: string;
  readonly skillName: string;
  readonly isForm: boolean;
  /**
   * Explicit operator confirmation for an irreversible action. Purge is
   * destructive and cannot be undone, so the form must carry this rather than
   * letting a single click erase a raw experience envelope.
   */
  readonly confirm: string;
}

const PURGE_REASONS = ["privacy_request", "retention_expired"] as const;

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
      experienceId: String(formData.get("experienceId") ?? "").trim(),
      workspaceId:
        String(formData.get("workspaceId") ?? "").trim() ||
        "SimulatorLife/AutoDev",
      reason: String(formData.get("reason") ?? "").trim(),
      claim: String(formData.get("claim") ?? "").trim(),
      skillName: String(formData.get("skillName") ?? "").trim(),
      confirm: String(formData.get("confirm") ?? "").trim(),
      isForm: true
    };
  }

  try {
    const json = (await request.json()) as Record<string, unknown>;
    return {
      action: String(json.action ?? "").trim(),
      recordId: String(json.recordId ?? "").trim(),
      experienceId: String(json.experienceId ?? "").trim(),
      workspaceId:
        String(json.workspaceId ?? "").trim() || "SimulatorLife/AutoDev",
      reason: String(json.reason ?? "").trim(),
      claim: String(json.claim ?? "").trim(),
      skillName: String(json.skillName ?? "").trim(),
      confirm: String(json.confirm ?? "").trim(),
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
  const {
    action,
    recordId,
    experienceId,
    workspaceId,
    reason,
    claim,
    skillName,
    confirm
  } = payload;
  switch (action) {
    case "purge": {
      // Purge erases an experience envelope irreversibly, so it is validated
      // separately from the record lifecycle: it targets `experienceId`, it
      // needs a Runtime-accepted reason, and it needs explicit confirmation.
      if (!experienceId) return null;
      if (confirm !== "purge") return null;
      if (!(PURGE_REASONS as readonly string[]).includes(reason)) return null;
      return purgeMemoryExperience(
        experienceId,
        reason as (typeof PURGE_REASONS)[number],
        { workspaceId },
        config
      );
    }
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
  // Purge targets an experience rather than a durable record, so each action
  // names the identifier it needs instead of demanding `recordId` up front.
  const identifier =
    payload?.action === "purge" ? payload.experienceId : payload?.recordId;
  if (!payload || !identifier) {
    return NextResponse.json(
      { error: "Invalid request payload or missing identifier" },
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
    redirectUrl.searchParams.set("recordId", identifier);
    return NextResponse.redirect(redirectUrl, { status: 303 });
  }

  return NextResponse.json({
    success: true,
    action: payload.action,
    recordId: payload.recordId
  });
}
