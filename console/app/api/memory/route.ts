import { type NextRequest, NextResponse } from "next/server.js";

import {
  type ControlRefusalReason,
  withControlFailure,
  withControlRefusal
} from "../../../src/lib/control-failure.ts";
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
   * The query string of the list this action was made on.
   *
   * A redirect that rebuilds its query from scratch returns the operator to an
   * unfiltered 30-day list, so a verify made inside `kind=procedural` on a
   * 90-day window lands them somewhere they were not working. Only the filter
   * keys are read back; see `memoryReturnQuery`.
   */
  readonly returned?: string | undefined;
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

/**
 * The filter keys a mutation may carry back from the list it was made on.
 *
 * Everything else is dropped, including anything that could name another
 * destination. The route never follows a submitted string: it re-parses these
 * keys and rebuilds `/memory?…` from them, so the field is a set of facts about
 * the operator's filters rather than a redirect target, and a crafted value can
 * at worst describe a filter the page will then refuse to apply and name.
 */
const MEMORY_RETURN_KEYS: ReadonlySet<string> = new Set([
  "query",
  "kind",
  "status",
  "from",
  "until",
  "limit",
  "offset"
]);

/** A carried filter value is read, never rendered into the page unescaped. */
const MAX_RETURN_VALUE_LENGTH = 256;
/** The whole carried query is bounded too, so the parse is cheap. */
const MAX_RETURN_QUERY_LENGTH = 2048;

/**
 * Where a Memory mutation sends the browser back to.
 *
 * The action decides the tab and the selection — a purge acts on an experience
 * whatever it was submitted from, and the operator comes back to the item they
 * acted on rather than to the top of a list — while the filters they were
 * working inside come from the form.
 */
function memoryReturnQuery(
  payload: MemoryActionPayload,
  isPurge: boolean,
  identifier: string | undefined
): URLSearchParams {
  const query = new URLSearchParams();
  const returned = payload.returned;
  if (returned !== undefined && returned.length <= MAX_RETURN_QUERY_LENGTH) {
    for (const [key, value] of new URLSearchParams(returned)) {
      if (
        MEMORY_RETURN_KEYS.has(key) &&
        value.length <= MAX_RETURN_VALUE_LENGTH
      ) {
        query.set(key, value);
      }
    }
  }
  if (identifier === undefined || identifier === "") {
    query.set("tab", isPurge ? "experiences" : "records");
  } else {
    const selection = selectionQuery(isPurge, identifier);
    query.set("tab", selection.get("tab") ?? "records");
    query.set(isPurge ? "experienceId" : "recordId", identifier);
  }
  if (payload.workspaceId !== "") {
    query.set("workspaceId", payload.workspaceId);
  }
  return query;
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
      ...(formData.has("returned")
        ? { returned: String(formData.get("returned") ?? "") }
        : {}),
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
      ...(typeof json.returned === "string" ? { returned: json.returned } : {}),
      isForm: false
    };
  } catch {
    return null;
  }
}

/**
 * Run one action, or report why this route would not send it.
 *
 * The refusal reason is returned rather than a bare `null` because the three
 * reasons a purge can be turned down here need different operator responses, and
 * two of them are indistinguishable from the action alone: a purge with the
 * confirmation ticked but a reason the Runtime does not accept is *not* a
 * missing confirmation. Keying the reason off the action -- which is what a
 * single `null` invites -- would state a false cause on a form the operator had
 * filled in correctly.
 */
function executeAction(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): Promise<ControlApiResult<unknown>> | ControlRefusalReason | null {
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
      if (!experienceId) return "confirmation_missing";
      if (confirm !== "purge") return "confirmation_missing";
      if (!(PURGE_REASONS as readonly string[]).includes(reason))
        return "reason_not_accepted";
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
      // A revision *is* the replacement text. Without one there is nothing to
      // send, and saying "reason not accepted" would blame a reason the
      // operator filled in perfectly.
      if (!claim) return "claim_required";
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
    identifier?: string,
    refusal?: ControlRefusalReason
  ): NextResponse => {
    if (payload?.isForm === true) {
      // Re-select the subject whenever it is known. A refusal that lands on the
      // tab without the item the operator acted on leaves them to work out
      // which of the rows in the table failed, which is not something the notice
      // can tell them.
      return redirectTo(
        refusal === undefined
          ? withControlFailure(
              `/memory?${memoryReturnQuery(payload, isPurge, identifier).toString()}`
            )
          : withControlRefusal(
              `/memory?${memoryReturnQuery(payload, isPurge, identifier).toString()}`,
              refusal
            )
      );
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
      identifier,
      "reason_not_accepted"
    );
  }
  // The route refused to send it, and says which of its own checks stopped it.
  if (typeof result === "string") {
    return respond(
      400,
      `Unsupported or incomplete action: ${payload.action}`,
      identifier,
      result
    );
  }

  if (result.kind !== "ok") {
    return respond(
      "status" in result ? result.status : 500,
      result,
      identifier,
      "runtime_refused"
    );
  }

  if (payload.isForm) {
    return redirectTo(
      `/memory?${memoryReturnQuery(payload, isPurge, identifier).toString()}`
    );
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
