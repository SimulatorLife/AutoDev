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
  reportMemoryExperienceSessionOutcome,
  reportMemoryInjectionUse,
  transitionMemoryRecord
} from "../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  isUrlEncodedFormRequest,
  readStrictUrlEncodedFormBody
} from "../../../src/lib/server/form-mutation.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * How large a form body this route will read.
 *
 * The promotion carries the record's own content into a skill, so the bound
 * is the one the route that writes a skill body uses rather than the smaller
 * one a toggle needs.
 */
const MAX_FORM_BODY_BYTES = 160_000;

interface MemoryActionPayload {
  readonly action: string;
  readonly recordId: string;
  readonly experienceId: string;
  readonly workspaceId: string;
  readonly reason: string;
  readonly claim: string;
  /**
   * The record a supersession retires.
   *
   * Supersession is the only transition that takes a second record as its
   * subject, so the identifier is the action's own rather than the tab's.
   */
  readonly priorId: string;
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
  "recordId" | "experienceId" | "correlationToken" | "injectionEventId";

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
const MEMORY_ACTION_TARGETS: Readonly<Record<string, MemoryActionTarget>> = {
  verify: {
    tab: "records",
    subjectField: "recordId",
    required: ["recordId"]
  },
  supersede: {
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
  },
  // The session-level outcome acts on the experience alone: it is about the
  // session, not about one injected packet, so unlike the two reports above it
  // carries no per-injection identifier to require.
  "report-session-outcome": {
    tab: "experiences",
    subjectField: "experienceId",
    required: ["experienceId"]
  }
};

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

/**
 * The refusal a write from another origin gets.
 *
 * A form submission is a browser navigation, so the answer is a redirect back
 * into Memory carrying the shared could-not-be-confirmed notice: the operator
 * is told the change did not happen instead of being handed a bare status
 * page outside the Console shell. A caller that asked for a body gets a
 * status and a body.
 *
 * The refusal names nothing about the request beyond its origin. It says the
 * request was refused, and it does not become a channel for echoing what
 * another site sent.
 */
function refuseCrossOrigin(request: NextRequest): NextResponse {
  if (isUrlEncodedFormRequest(request)) {
    return redirectTo(withControlFailure("/memory"));
  }
  return NextResponse.json(
    { error: "Cross-origin request refused" },
    { status: 403 }
  );
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
  if (isUrlEncodedFormRequest(request)) {
    // The bounded parser, not `request.formData()`: this route holds the
    // service credential and writes to the Runtime's memory, so the body it
    // reads is bounded the way every other write route's body is.
    const form = await readStrictUrlEncodedFormBody(
      request,
      MAX_FORM_BODY_BYTES
    );
    if (form === null) return null;
    return {
      action: String(form.get("action") ?? "").trim(),
      recordId: String(form.get("recordId") ?? "").trim(),
      experienceId: String(form.get("experienceId") ?? "").trim(),
      workspaceId:
        String(form.get("workspaceId") ?? "").trim() || "SimulatorLife/AutoDev",
      reason: String(form.get("reason") ?? "").trim(),
      claim: String(form.get("claim") ?? "").trim(),
      priorId: String(form.get("priorId") ?? "").trim(),
      skillName: String(form.get("skillName") ?? "").trim(),
      promotedContent: String(form.get("promotedContent") ?? "").trim(),
      correlationToken: String(form.get("correlationToken") ?? "").trim(),
      outcomeKind: String(form.get("outcomeKind") ?? "").trim(),
      reportKind: String(form.get("reportKind") ?? "").trim(),
      useKind: String(form.get("useKind") ?? "").trim(),
      injectionEventId: String(form.get("injectionEventId") ?? "").trim(),
      sourceExperienceIds: String(form.get("experienceIds") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== ""),
      usedMemoryIds: String(form.get("usedMemoryIds") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== ""),
      evidence: [
        {
          kind: String(form.get("evidenceKind") ?? "").trim(),
          uri: String(form.get("evidenceUri") ?? "").trim()
        }
      ].filter((reference) => reference.kind !== "" && reference.uri !== ""),
      confirm: String(form.get("confirm") ?? "").trim(),
      ...(form.has("returned")
        ? { returned: String(form.get("returned") ?? "") }
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
      priorId: String(json.priorId ?? "").trim(),
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
 * The refusal the operator is told about, given what the Runtime answered.
 *
 * The Runtime states its reasons with machine-readable codes, and every one asks
 * for a different next move: a conflict means reload and retry, a scope refusal
 * means do not bother, and a reference means the thing being changed is
 * load-bearing. Collapsing all of them into one notice made that notice offer
 * "it may still be citing this record" as the explanation for every failure,
 * which sent an operator whose supersession was rejected for an unrelated
 * reason looking for citations that were never involved.
 *
 * Anything unrecognised stays `runtime_refused`, whose sentence now says only
 * that the change did not happen and does not guess why.
 */
function memoryRefusalFor(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): ControlRefusalReason {
  if (result.kind === "unreachable") return "unavailable";
  const code = "code" in result ? result.code : "";
  switch (code) {
    case "autodev_memory_experience_referenced": {
      return "still_cited";
    }
    case "autodev_memory_conflict": {
      return "conflicted";
    }
    case "autodev_memory_not_found": {
      return "not_found";
    }
    case "autodev_memory_scope_forbidden":
    case "autodev_memory_viewer_forbidden":
    case "autodev_memory_task_history_forbidden":
    case "autodev_memory_forbidden": {
      return "forbidden";
    }
    case "autodev_memory_unavailable": {
      return "unavailable";
    }
    // The Runtime accepted the body and the operation then failed, which is a
    // different thing from the fallback's "declined without saying why". It said
    // exactly why, so telling the operator otherwise sends them to look for a
    // mistake in a form that was correct.
    case "autodev_memory_operation_failed": {
      return "operation_failed";
    }
    // A 400 carrying a specific reason: the request failed validation before
    // any work started. Mapping it to the fallback was wrong twice over — it
    // made the notice claim the Runtime said nothing, when the code names the
    // cause, and it left the operator with nothing to act on when the cause is
    // in a body the route assembled rather than one they filled in.
    case "autodev_memory_invalid_request":
    case "autodev_memory_capture_invalid": {
      return "request_invalid";
    }
    default: {
      return "runtime_refused";
    }
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
type MemoryActionResult =
  Promise<ControlApiResult<unknown>> | ControlRefusalReason | null;

function executePurge(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  // Purge erases an experience envelope irreversibly, so it targets the
  // experience and requires explicit confirmation and a Runtime reason.
  if (!payload.experienceId || payload.confirm !== "purge") {
    return "confirmation_missing";
  }
  if (!(PURGE_REASONS as readonly string[]).includes(payload.reason)) {
    return "reason_not_accepted";
  }
  return purgeMemoryExperience(
    payload.experienceId,
    payload.reason as (typeof PURGE_REASONS)[number],
    { workspaceId: payload.workspaceId },
    config
  );
}

function executeVerify(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  // The Runtime reads a task and query, not the free-text reason by itself.
  const task = payload.reason.trim();
  if (!task) return "reason_required";
  return transitionMemoryRecord(
    payload.recordId,
    "verify",
    { workspaceId: payload.workspaceId, task, query: payload.reason },
    config
  );
}

function executeSupersede(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  // Name the prior record locally so a missing selection is not reported as
  // an unrelated Runtime validation failure.
  if (!payload.priorId) return "prior_required";
  const task = payload.reason.trim();
  if (!task) return "reason_required";
  return transitionMemoryRecord(
    payload.recordId,
    "supersede",
    {
      workspaceId: payload.workspaceId,
      priorId: payload.priorId,
      task,
      query: payload.reason
    },
    config
  );
}

function executeInvalidate(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  // Invalidation is permanent and requires a bounded reason plus evidence.
  if (payload.evidence.length === 0) return "evidence_required";
  if (!isMemoryReasonCode(payload.reason)) return "reason_not_accepted";
  return transitionMemoryRecord(
    payload.recordId,
    "invalidate",
    {
      workspaceId: payload.workspaceId,
      reasonCode: payload.reason,
      evidence: payload.evidence
    },
    config
  );
}

function executeRevise(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  if (!payload.claim) return "claim_required";
  if (payload.evidence.length === 0) return "evidence_required";
  const experienceIds = [...new Set(payload.sourceExperienceIds)];
  if (experienceIds.length === 0) return "provenance_required";
  return transitionMemoryRecord(
    payload.recordId,
    "revise",
    {
      workspaceId: payload.workspaceId,
      claim: payload.claim,
      experienceIds,
      evidence: payload.evidence
    },
    config
  );
}

function executeOutcomeReport(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  if (payload.outcomeKind !== "unknown" && payload.evidence.length === 0) {
    return "evidence_required";
  }
  return reportMemoryExperienceOutcome(
    payload.experienceId,
    {
      workspaceId: payload.workspaceId,
      correlationToken: payload.correlationToken,
      outcomeKind: payload.outcomeKind,
      reportKind: payload.reportKind,
      evidence: payload.evidence
    },
    config
  );
}

function executeUseReport(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  // The Runtime binds the curator assessment to the cited injection and ids.
  return reportMemoryInjectionUse(
    payload.experienceId,
    {
      workspaceId: payload.workspaceId,
      injectionEventId: payload.injectionEventId,
      useKind: payload.useKind,
      usedMemoryIds: payload.usedMemoryIds,
      evidence: payload.evidence
    },
    config
  );
}

function executeSessionOutcomeReport(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  if (payload.outcomeKind !== "unknown" && payload.evidence.length === 0) {
    return "evidence_required";
  }
  return reportMemoryExperienceSessionOutcome(
    payload.experienceId,
    {
      workspaceId: payload.workspaceId,
      outcomeKind: payload.outcomeKind,
      reportKind: payload.reportKind,
      evidence: payload.evidence
    },
    config
  );
}

function executeSkillPromotion(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  const name =
    payload.skillName || `memory-proc-${payload.recordId.slice(0, 8)}`;
  const task = payload.reason.trim();
  if (!task) return "reason_required";
  if (!payload.promotedContent) return "content_required";
  return promoteMemoryProcedureToSkill(
    {
      workspaceId: payload.workspaceId,
      skillName: name,
      description: `Promoted from durable procedure memory ${payload.recordId}`,
      content: payload.promotedContent,
      task,
      query: payload.reason
    },
    config
  );
}

function executeAction(
  payload: MemoryActionPayload,
  config: ControlApiConfig
): MemoryActionResult {
  switch (payload.action) {
    case "purge": {
      return executePurge(payload, config);
    }
    case "verify": {
      return executeVerify(payload, config);
    }
    case "supersede": {
      return executeSupersede(payload, config);
    }
    case "invalidate": {
      return executeInvalidate(payload, config);
    }
    case "revise": {
      return executeRevise(payload, config);
    }
    case "report-outcome": {
      return executeOutcomeReport(payload, config);
    }
    case "report-use": {
      return executeUseReport(payload, config);
    }
    case "report-session-outcome": {
      return executeSessionOutcomeReport(payload, config);
    }
    case "promote-skill": {
      return executeSkillPromotion(payload, config);
    }
    default: {
      return null;
    }
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // This route holds the service credential and writes to the Runtime's
  // memory -- an irreversible purge among them -- so the origin is the only
  // thing that separates an operator's own click from a page on another site
  // making the request on the operator's behalf. Every other write route in
  // the Console checks it; this one did not, and a cross-site form post is a
  // simple request: no preflight, no header a page cannot set by itself.
  //
  // The check comes before the body is read, so a refused request costs
  // nothing and a body nobody may submit is never parsed.
  if (!isSameOriginMutation(request)) {
    return refuseCrossOrigin(request);
  }
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
      memoryRefusalFor(result)
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
