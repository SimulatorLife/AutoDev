import {
  MEMORY_EXPERIENCE_PURGE_REASONS,
  MEMORY_REASON_CODES
} from "@simulatorlife/autodev-core";

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
  reportMemoryExperienceOutcome,
  reportMemoryInjectionUse,
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
  /**
   * The procedure body a promotion writes to the skill catalog. The Runtime
   * requires it and refuses a promotion without one, so the records view sends
   * the record's own content rather than letting the Runtime write a skill
   * file with only a name and a description in it.
   */
  readonly promotedContent: string;
  readonly correlationToken: string;
  readonly outcomeKind: string;
  readonly reportKind: string;
  readonly useKind: string;
  readonly injectionEventId: string;
  readonly usedMemoryIds: readonly string[];
  /**
   * The experiences the record was derived from, as the records view renders
   * them from the record's own provenance. A revision has to cite them, and
   * the view is the only place that knows them; a request that invents a set
   * would produce a revision nobody can trace.
   */
  readonly sourceExperienceIds: readonly string[];
  readonly evidence: readonly {
    readonly kind: string;
    readonly uri: string;
    readonly revision?: string;
  }[];
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

/**
 * The Runtime's purge vocabulary, read from Core rather than restated.
 *
 * Checking a submitted reason against a local copy of the two codes was a
 * re-spelling of a list the Runtime reads from Core, so the two could disagree
 * with nothing to notice.
 */
const PURGE_REASONS = MEMORY_EXPERIENCE_PURGE_REASONS;

/**
 * Is this one of the Runtime's bounded reason codes?
 *
 * Checked against Core's own list rather than a copy of it, so a code the
 * Runtime adds is accepted here the day it is added and one it drops stops
 * being accepted the day it is dropped. Free text is refused: an invalidation
 * is permanent, and "the operator had a feeling" is not something an audit
 * record can carry.
 */
function isMemoryReasonCode(value: string): value is string {
  return (MEMORY_REASON_CODES as readonly string[]).includes(value);
}

/** The payload fields a report names the single thing it acts on. */
type MemorySubjectField =
  | "recordId"
  | "experienceId"
  | "correlationToken"
  | "injectionEventId";

interface MemoryActionTarget {
  /** The tab the operator came from and is sent back to. */
  readonly tab: "records" | "experiences";
  /** The key that tab reads its selection from, and that the page reads it back from. */
  readonly subjectField: Extract<
    MemorySubjectField,
    "recordId" | "experienceId"
  >;
  /**
   * Every field the action must carry to be sendable at all.
   *
   * A report names the one injection it describes as well as the experience it
   * belongs to, because the Runtime binds an outcome to a correlation token and
   * a use assessment to an injection event id. Those are not optional filters:
   * a report without one has nothing to bind to, so it is a malformed request
   * rather than a refusal with a reason to report.
   */
  readonly required: readonly MemorySubjectField[];
}

/**
 * What each action acts on.
 *
 * Keyed by action rather than by tab because the two are not the same question.
 * Purge and both reports act on an experience while every other action acts on a
 * durable record, but the reports also carry the identifier of the single
 * injection they annotate. Deriving the subject from the action's shape — which
 * is what a single `isPurge` boolean invites — got the identifier gate wrong for
 * two of the three actions it was meant to describe.
 */
const MEMORY_ACTION_TARGETS: Readonly<
  Record<string, MemoryActionTarget>
> = {
  verify: {
    tab: "records",
    subjectField: "recordId",
    required: ["recordId"]
  },
  invalidate: {
    tab: "records",
    subjectField: "recordId",
    required: ["recordId"]
  },
  revise: {
    tab: "records",
    subjectField: "recordId",
    required: ["recordId"]
  },
  "promote-skill": {
    tab: "records",
    subjectField: "recordId",
    required: ["recordId"]
  },
  purge: {
    tab: "experiences",
    subjectField: "experienceId",
    required: ["experienceId"]
  },
  "report-outcome": {
    tab: "experiences",
    subjectField: "experienceId",
    required: ["experienceId", "correlationToken"]
  },
  "report-use": {
    tab: "experiences",
    subjectField: "experienceId",
    required: ["experienceId", "injectionEventId"]
  }
};

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

/**
 * The query a redirect back to Memory needs to re-select what was acted on.
 *
 * A purge acts on an experience and the experiences tab reads its selection from
 * `experienceId`; every other action acts on a durable record, which the records
 * tab reads from `recordId`. One key, because getting it wrong is silent rather
 * than loud: the redirect still lands on the right tab, still carries the right
 * identifier, and simply spells it under a key that tab ignores -- so the drawer
 * does not open and the operator is dropped onto a bare list. After an
 * irreversible purge that is the worst possible outcome: the subject of the
 * action disappears from the page, and on the failure path nothing identified it
 * in the first place.
 */
function selectionQuery(
  target: MemoryActionTarget,
  identifier: string
): URLSearchParams {
  return new URLSearchParams({
    tab: target.tab,
    [target.subjectField]: identifier
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
  target: MemoryActionTarget,
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
    query.set("tab", target.tab);
  } else {
    const selection = selectionQuery(target, identifier);
    query.set("tab", selection.get("tab") ?? target.tab);
    query.set(target.subjectField, identifier);
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
      promotedContent: String(formData.get("promotedContent") ?? "").trim(),
      correlationToken: String(formData.get("correlationToken") ?? "").trim(),
      outcomeKind: String(formData.get("outcomeKind") ?? "").trim(),
      reportKind: String(formData.get("reportKind") ?? "").trim(),
      useKind: String(formData.get("useKind") ?? "").trim(),
      injectionEventId: String(formData.get("injectionEventId") ?? "").trim(),
      sourceExperienceIds: String(formData.get("experienceIds") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== ""),
      usedMemoryIds: String(formData.get("usedMemoryIds") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== ""),
      evidence: [
        {
          kind: String(formData.get("evidenceKind") ?? "").trim(),
          uri: String(formData.get("evidenceUri") ?? "").trim()
        }
      ].filter((reference) => reference.kind !== "" && reference.uri !== ""),
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
      promotedContent: String(json.promotedContent ?? "").trim(),
      correlationToken: String(json.correlationToken ?? "").trim(),
      outcomeKind: String(json.outcomeKind ?? "").trim(),
      reportKind: String(json.reportKind ?? "").trim(),
      useKind: String(json.useKind ?? "").trim(),
      injectionEventId: String(json.injectionEventId ?? "").trim(),
      usedMemoryIds: Array.isArray(json.usedMemoryIds)
        ? json.usedMemoryIds
            .map((value) => String(value).trim())
            .filter((value) => value !== "")
        : [],
      sourceExperienceIds: Array.isArray(json.sourceExperienceIds)
        ? json.sourceExperienceIds
            .map((value) => String(value).trim())
            .filter((value) => value !== "")
        : [],
      evidence: Array.isArray(json.evidence)
        ? json.evidence
            .filter(
              (value): value is Record<string, unknown> =>
                Boolean(value) && typeof value === "object"
            )
            .map((value) => ({
              kind: String(value.kind ?? "").trim(),
              uri: String(value.uri ?? "").trim()
            }))
            .filter((value) => value.kind !== "" && value.uri !== "")
        : [],
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
 * The refusal reason is returned rather than a bare `null` because the reasons a
 * route can turn a submission down on itself need different operator responses,
 * and two of them are indistinguishable from the action alone: a purge with the
 * confirmation ticked but a reason the Runtime does not accept is *not* a missing
 * confirmation. Keying the reason off the action -- which is what a single `null`
 * invites -- would state a false cause on a form the operator had filled in
 * correctly.
 *
 * Only checks the Runtime would otherwise answer are made here, and only where
 * the route's own answer says more than the Runtime's would: that nothing was
 * sent. Whether the injection belongs to the reporter, whether an outcome kind is
 * one the Runtime accepts, and whether cited memories are the injected set are all
 * the Runtime's to decide -- it holds the experience, and this route does not.
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
    correlationToken,
    outcomeKind,
    reportKind,
    useKind,
    injectionEventId,
    usedMemoryIds,
    sourceExperienceIds,
    promotedContent,
    evidence,
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
      // The Runtime reads this action's body through `researchRequest`: a task
      // and a query, nothing else. A free-text reason is not one of its keys,
      // so sending one was a malformed request rather than a thin one.
      const task = reason.trim();
      if (!task) return "reason_required";
      return transitionMemoryRecord(
        recordId,
        "verify",
        { workspaceId, task, query: reason },
        config
      );
    }
    case "invalidate": {
      // Invalidation is permanent and permanent things need a reason an audit
      // record can count on, so the Runtime takes one of its bounded
      // `reasonCode`s rather than free text, and evidence of what contradicted
      // the record. Both are checked here so the refusal names the missing
      // field instead of arriving as a generic 400 from the Runtime.
      if (!evidence.length) return "evidence_required";
      if (!isMemoryReasonCode(reason)) return "reason_not_accepted";
      return transitionMemoryRecord(
        recordId,
        "invalidate",
        { workspaceId, reasonCode: reason, evidence },
        config
      );
    }
    case "revise": {
      // A revision *is* the replacement text. Without one there is nothing to
      // send, and saying "reason not accepted" would blame a reason the
      // operator filled in perfectly.
      if (!claim) return "claim_required";
      if (!evidence.length) return "evidence_required";
      // The Runtime requires the experiences a revision derives from, and the
      // record's own provenance already names them — citing the record's
      // sources is honest, where inventing a set would not be.
      const experienceIds = [...new Set(sourceExperienceIds)];
      // A record whose provenance cites no experiences cannot be revised from
      // here at all: there is nothing to re-derive the claim from, and the form
      // has no way to supply them. Reporting that as missing evidence blamed a
      // field the operator had filled in correctly, which sends them to fix
      // something that was never wrong.
      if (experienceIds.length === 0) return "provenance_required";
      return transitionMemoryRecord(
        recordId,
        "revise",
        { workspaceId, claim, experienceIds, evidence },
        config
      );
    }
    case "report-outcome": {
      // An outcome binds to one observed injection, not to the experience, so it
      // carries the correlation token the Runtime minted for that injection. The
      // Runtime re-resolves it against the reporter's trusted scope, so a token
      // that does not belong here fails there rather than binding a report to
      // someone else's injection.
      //
      // Evidence is checked here rather than forwarded. A non-`unknown` outcome
      // with none is refused by the Runtime, and naming the missing field locally
      // says something the Runtime's message could not: the request never reached
      // it, so the outcome is unrecorded rather than rejected.
      if (outcomeKind !== "unknown" && evidence.length === 0) {
        return "evidence_required";
      }
      return reportMemoryExperienceOutcome(
        experienceId,
        {
          workspaceId,
          correlationToken,
          outcomeKind,
          reportKind,
          evidence
        },
        config
      );
    }
    case "report-use": {
      // A curator assessment names the injection it judges and the memories it
      // saw used. The Runtime holds the verdict to its own cited ids, so the
      // Console forwards them without deciding anything.
      return reportMemoryInjectionUse(
        experienceId,
        {
          workspaceId,
          injectionEventId,
          useKind,
          usedMemoryIds,
          evidence
        },
        config
      );
    }
    case "promote-skill": {
      const name = skillName || `memory-proc-${recordId.slice(0, 8)}`;
      // The Runtime requires the procedure's own `content` alongside the name
      // and description, and a research context for the promotion. `memoryId`
      // is not one of its keys — it lives in the path, not the body — so
      // sending it was a malformed request.
      const task = reason.trim();
      if (!task) return "reason_required";
      if (!promotedContent) return "content_required";
      return promoteMemoryProcedureToSkill(
        {
          workspaceId,
          skillName: name,
          description: `Promoted from durable procedure memory ${recordId}`,
          content: promotedContent,
          task,
          query: reason
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
  // The subject is the action's, not the tab's. Purge and both reports act on an
  // experience rather than a durable record, and each report additionally names
  // the one injection it annotates.
  const target =
    payload === null ? undefined : MEMORY_ACTION_TARGETS[payload.action];

  // An action this route does not implement has no subject, no tab, and no cause
  // to report, so there is nothing a redirect could name. It answers the caller
  // instead, which is also the only honest thing to do with a payload the route
  // cannot place.
  if (payload === null || target === undefined) {
    return NextResponse.json(
      { error: "Invalid request payload or unsupported action" },
      { status: 400 }
    );
  }
  const identifier = payload[target.subjectField];

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
    refusal?: ControlRefusalReason
  ): NextResponse => {
    if (payload.isForm === true) {
      // Re-select the subject whenever it is known. A refusal that lands on the
      // tab without the item the operator acted on leaves them to work out
      // which of the rows in the table failed, which is not something the notice
      // can tell them.
      return redirectTo(
        refusal === undefined
          ? withControlFailure(
              `/memory?${memoryReturnQuery(payload, target, identifier).toString()}`
            )
          : withControlRefusal(
              `/memory?${memoryReturnQuery(payload, target, identifier).toString()}`,
              refusal
            )
      );
    }
    return NextResponse.json({ error }, { status });
  };

  // Every field the action must name, checked together. A report missing its
  // correlation token or injection id was never sendable -- the Runtime binds both
  // to one injection -- so it is a malformed request with no cause to report,
  // exactly like a missing identifier, and reporting a refusal reason for it
  // would name a field the operator never saw. The tab is still known, so the
  // form is sent back to where it came from.
  if (target.required.some((field) => payload[field] === "")) {
    return respond(400, "Invalid request payload or missing identifier");
  }

  const config = readControlApiConfig();
  if (!config) {
    return respond(503, "Control API configuration or token is missing");
  }

  const result = await executeAction(payload, config);
  // `executeAction` returns a reason rather than a bare null because the checks a
  // route can refuse on itself need different operator responses, and two of them
  // are indistinguishable from the action alone: a purge with the confirmation
  // ticked but a reason the Runtime does not accept is *not* a missing
  // confirmation. Keying the reason off the action -- which is what a single null
  // invites -- would state a false cause on a form the operator had filled in
  // correctly.
  if (typeof result === "string") {
    return respond(
      400,
      `Unsupported or incomplete action: ${payload.action}`,
      result
    );
  }
  // Every action in MEMORY_ACTION_TARGETS is implemented here, so a null now means
  // the two tables have drifted rather than that a caller asked for something odd.
  if (!result) {
    throw new Error(
      `Memory action "${payload.action}" has no implementation; add it to executeAction.`
    );
  }

  if (result.kind !== "ok") {
    return respond(
      "status" in result ? result.status : 500,
      result,
      "runtime_refused"
    );
  }

  if (payload.isForm) {
    return redirectTo(
      `/memory?${memoryReturnQuery(payload, target, identifier).toString()}`
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
