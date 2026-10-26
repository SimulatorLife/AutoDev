/**
 * Same-origin boundary for writing one hook event's canonical declaration.
 *
 * The route receives the operator's edit, validates its same-origin browser
 * context, and forwards a typed PATCH to Runtime using the server-side Control
 * API credential. The browser never receives that credential and never
 * bypasses Runtime: the declaration is written by the Runtime, which applies
 * the projection and observes what it published.
 *
 * The route answers with a redirect rather than with a body. That is the
 * Console's own mutation boundary: the navigation owner reads the redirect,
 * moves the page to the destination, and the page renders the outcome from the
 * query. A route that answered with a body instead would leave the page
 * holding the state it had before the write, which is how a feature ends up
 * showing two truths about the same declaration.
 *
 * Only POST is exported. A refused write answers with the Runtime's reason --
 * a conflict, a refused declaration or a failed projection are different
 * facts, and the operator is told which one happened.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  HOOKS_PATH,
  hookWriteReturnPath
} from "../../../../src/features/hooks/paths.ts";
import {
  type CanonicalSourceSaveOutcome,
  editorBaseRevision
} from "../../../../src/lib/server/canonical-source.ts";
import {
  patchHookEvent,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";

const HOOK_EVENT_PATTERN = /^[a-z][A-Za-z]{0,63}$/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
/**
 * The field names one action's group carries.
 *
 * The index is what keeps the three fields of one action together, and it is
 * what lets the operator reorder or remove an action without a form field
 * carrying two values at once.
 */
const ACTION_FIELD_PATTERN = /^(?:command|matcher|statusMessage)-(\d+)$/u;
const MAX_FORM_BODY_BYTES = 64_000;
const MAX_ACTIONS = 64;

/**
 * The redirect back to the surface the write came from.
 *
 * The editor is on the list and on the event's own page, so the write answers
 * to whichever of the two the operator used: a write that answered with a
 * redirect to the top of the page would leave the operator looking at a list
 * that says nothing about what they just changed.
 *
 * The destination is a bounded Hooks path and not one the browser chose, so a
 * write can never redirect off this Console.
 */
function redirectToHooks(
  returnTo: string,
  event: string,
  outcome?: CanonicalSourceSaveOutcome,
  basedOn?: string
): NextResponse {
  const query = new URLSearchParams();
  if (outcome) query.set("save", outcome);
  if (basedOn) query.set("based", basedOn);
  // The list names the event it is showing the outcome for; the event's own
  // page has the event in its path, and repeating it in the query would be a
  // second place for the same fact to disagree.
  if (returnTo === HOOKS_PATH) query.set("event", event);
  const suffix = query.toString();
  return new NextResponse(null, {
    status: 303,
    headers: { location: `${returnTo}${suffix.length > 0 ? `?${suffix}` : ""}` }
  });
}

/**
 * The action list the form carries.
 *
 * The form carries one group of fields per action, and the group is named by
 * its index: `command-0`, `matcher-0`, `statusMessage-0`. The index is what
 * keeps the three fields of one action together, and it is what lets the
 * operator reorder or remove an action without a form field carrying two
 * values at once.
 *
 * An action whose command is empty is dropped rather than written: an empty
 * command is how the editor says "this action is not there", and writing it
 * would declare a hook that runs nothing.
 */
function readActions(form: URLSearchParams): {
  readonly actions: readonly {
    readonly type: "command";
    readonly command: string;
    readonly matcher?: string;
    readonly statusMessage?: string;
  }[];
} | null {
  const indexes = new Set<number>();
  for (const key of form.keys()) {
    const match = ACTION_FIELD_PATTERN.exec(key);
    if (match) indexes.add(Number(match[1]));
  }
  if (indexes.size === 0 || indexes.size > MAX_ACTIONS) return null;
  const actions: {
    type: "command";
    command: string;
    matcher?: string;
    statusMessage?: string;
  }[] = [];
  for (const index of [...indexes].sort((left, right) => left - right)) {
    const command = form.get(`command-${index}`);
    const matcher = form.get(`matcher-${index}`);
    const statusMessage = form.get(`statusMessage-${index}`);
    if (command === null) return null;
    const trimmed = command.trim();
    if (trimmed.length === 0) continue;
    const trimmedMatcher = matcher?.trim() ?? "";
    const trimmedStatus = statusMessage?.trim() ?? "";
    actions.push({
      type: "command",
      command,
      ...(trimmedMatcher.length === 0 ? {} : { matcher: matcher! }),
      ...(trimmedStatus.length === 0 ? {} : { statusMessage: statusMessage! })
    });
  }
  return { actions };
}

/**
 * The outcome a refusal is reported as.
 *
 * A conflict and a refused declaration are different facts: the first says the
 * declaration moved under the write, the second says the write could not be
 * expressed. They get different outcomes, and the reason is the Runtime's.
 */
function saveOutcomeForFailure(
  result: Awaited<ReturnType<typeof patchHookEvent>>
): CanonicalSourceSaveOutcome {
  if (result.kind !== "http-error") return "failed";
  switch (result.code) {
    case "autodev_control_hook_revision_conflict": {
      return "conflict";
    }
    case "autodev_control_hook_invalid_declaration":
    case "autodev_control_hook_unknown_event":
    case "autodev_control_api_invalid_body": {
      return "validation";
    }
    case "autodev_control_hook_apply_failed": {
      return "apply-failed";
    }
    default: {
      return "failed";
    }
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ event: string }> }
): Promise<NextResponse> {
  const { event } = await context.params;
  if (!HOOK_EVENT_PATTERN.test(event)) {
    return redirectToHooks(HOOKS_PATH, event, "failed");
  }
  if (!isSameOriginMutation(request)) {
    return redirectToHooks(HOOKS_PATH, event, "failed");
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form || form.getAll("expectedRevision").length !== 1) {
    return redirectToHooks(HOOKS_PATH, event, "failed");
  }

  // Where the write answers to. The editor carries it and the route checks it
  // against the Hooks paths, so the destination is the surface the operator
  // wrote from and nothing else.
  const returnTo = hookWriteReturnPath(form.get("returnTo"), event);

  const expectedRevision = form.get("expectedRevision");
  if (expectedRevision === null || !REVISION_PATTERN.test(expectedRevision)) {
    return redirectToHooks(returnTo, event, "failed");
  }
  const actions = readActions(form);
  if (actions === null) {
    return redirectToHooks(returnTo, event, "validation");
  }

  const config = readControlApiConfig();
  if (!config) {
    return redirectToHooks(returnTo, event, "failed");
  }

  const result = await patchHookEvent(
    event,
    { expectedRevision, actions: actions.actions },
    config
  );
  if (result.kind === "ok") {
    return redirectToHooks(returnTo, event);
  }
  const outcome = saveOutcomeForFailure(result);
  return redirectToHooks(
    returnTo,
    event,
    outcome,
    editorBaseRevision(outcome, expectedRevision)
  );
}
