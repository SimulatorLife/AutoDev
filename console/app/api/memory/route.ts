import { type NextRequest, NextResponse } from "next/server.js";

import { withControlFailure } from "../../../src/lib/control-failure.ts";
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

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

/**
 * The query a redirect back to Memory needs to re-select what was acted on.
 *
 * Purge acts on an experience and the experiences tab reads its selection from
 * `experienceId`; every other action acts on a durable record, which the records
 * tab reads from `recordId`. One key, because getting it wrong is silent rather
 * than loud: the redirect still lands on the right tab, still carries the right
 * identifier, and simply spells it under a key that tab ignores -- so the drawer
 * does not open and the operator is dropped onto a bare list. After an
 * irreversible purge that is the worst possible outcome: the subject of the
 * action disappears from the page, and on the failure path nothing identified it
 * in the first place.
 */
function selectionQuery(isPurge: boolean, identifier: string): URLSearchParams {
  return new URLSearchParams({
    tab: isPurge ? "experiences" : "records",
    [isPurge ? "experienceId" : "recordId"]: identifier
  });
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
  const payload = await parsePayload(request);
  const isPurge = payload?.action === "purge";

  /**
   * A form submission is a browser navigation, so whatever this returns becomes
   * the page the operator sees. Returning JSON there dumps `{"error": ...}`
   * outside the Console shell with no way back, so a failed form redirect
   * returns to Memory carrying the shared could-not-be-confirmed notice. Only a
   * non-browser caller still receives a status code.
   */
  const respond = (
    status: number,
    error: unknown,
    identifier?: string
  ): NextResponse => {
    if (payload?.isForm === true) {
      // Re-select the subject whenever it is known. A refusal that lands on the
      // tab without the item the operator acted on leaves them to work out
      // which of the rows in the table failed, which is not something the notice
      // can tell them.
      const query =
        identifier === undefined || identifier === ""
          ? new URLSearchParams({ tab: isPurge ? "experiences" : "records" })
          : selectionQuery(isPurge, identifier);
      if (payload.workspaceId !== "") {
        query.set("workspaceId", payload.workspaceId);
      }
      return redirectTo(withControlFailure(`/memory?${query.toString()}`));
    }
    return NextResponse.json({ error }, { status });
  };

  const config = readControlApiConfig();
  if (!config) {
    return respond(503, "Control API configuration or token is missing");
  }

  // Purge targets an experience rather than a durable record, so each action
  // names the identifier it needs instead of demanding `recordId` up front.
  const identifier = isPurge ? payload?.experienceId : payload?.recordId;
  if (!payload || !identifier) {
    return respond(400, "Invalid request payload or missing identifier");
  }

  const result = await executeAction(payload, config);
  if (!result) {
    return respond(
      400,
      `Unsupported or incomplete action: ${payload.action}`,
      identifier
    );
  }

  if (result.kind !== "ok") {
    return respond(
      "status" in result ? result.status : 500,
      result,
      identifier
    );
  }

  if (payload.isForm) {
    const query = selectionQuery(isPurge, identifier);
    query.set("workspaceId", payload.workspaceId);
    return redirectTo(`/memory?${query.toString()}`);
  }

  return NextResponse.json({
    success: true,
    action: payload.action,
    // The acted-on identifier, under the name that matches what was acted on.
    // Reporting `recordId` for a purge answered "" -- the JSON caller that
    // just erased an envelope was told which record it was, which is none.
    id: identifier
  });
}
