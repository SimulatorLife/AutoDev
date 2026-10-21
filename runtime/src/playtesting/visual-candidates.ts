/**
 * The affordance proposer for a visual playtest turn.
 *
 * A decision backend answers with one action out of the set the Runtime
 * offers. Smart-direct grounds its own answer against the observation and
 * ignores the set; a backend that chooses from a list needs that list built
 * from the very same observation both backends read.
 */
import {
  PLAYTEST_VISUAL_ACTION_SCHEMA,
  type PlaytestVisualAction,
  type PlaytestVisualCandidate,
  type PlaytestVisualControl,
  type PlaytestVisualControlRole,
  type PlaytestVisualObservation
} from "@simulatorlife/autodev-core";

/**
 * How many candidates one observation may offer.
 *
 * The upstream choice question accepts at most 255 options, but a browser
 * screen shows far fewer actionable controls than that, and a small local
 * model compares a short list far more reliably than a long one. The Runtime
 * therefore offers a bounded set, and it reports the truncation instead of
 * dropping controls silently.
 */
export const MAX_VISUAL_CANDIDATES = 32;

/**
 * A candidate id becomes a JSON object key in the choice question and comes
 * back as the exact option the model chose, so it has to survive that round
 * trip unchanged. The Core's own control-id charset is the safe one: letters,
 * digits, dot, underscore, colon and dash.
 */
const UNSAFE_ID_CHARACTERS = /[^A-Za-z0-9._:-]/gu;
const MAX_CANDIDATE_ID_LENGTH = 128;
/** The bound the choice contract puts on one candidate description. */
const MAX_CANDIDATE_DESCRIPTION_LENGTH = 512;
/** The room left for a disambiguating suffix when two ids reduce alike. */
const MAX_ID_SUFFIX_ROOM = 8;
/**
 * The control roles the Runtime refuses to activate.
 *
 * The admission gate refuses an activation of a text field whatever its input
 * kind claims, so a candidate the Runtime would refuse to dispatch is never
 * offered in the first place.
 */
const TEXT_CONTROL_ROLES = new Set<PlaytestVisualControlRole>([
  "textbox",
  "combobox"
]);

/** One observation's candidate set, and whether the cap dropped anything. */
export interface VisualCandidateSet {
  /** The candidates a decision backend may choose from, in observation order. */
  readonly candidates: readonly PlaytestVisualCandidate[];
  /** How many controls in the observation could be acted on at all. */
  readonly actionableControlCount: number;
  /** Whether the cap dropped actionable controls. */
  readonly truncated: boolean;
  /** How many actionable controls the cap dropped. */
  readonly droppedCount: number;
}

/**
 * Build the candidate set for one observation, and say whether the cap
 * dropped anything.
 */
export function buildVisualCandidateSet(
  observation: PlaytestVisualObservation
): VisualCandidateSet {
  const actionable = observation.controls.filter(
    (control) =>
      control.enabled &&
      control.inputKind === "none" &&
      !TEXT_CONTROL_ROLES.has(control.role)
  );
  const takenIds = new Set<string>();
  const candidates = actionable
    .slice(0, MAX_VISUAL_CANDIDATES)
    .map((control) => {
      const id = candidateId(control.controlId, takenIds);
      takenIds.add(id);
      return {
        id,
        description: describeControl(control),
        action: activateControl(observation, control.controlId)
      };
    });
  return {
    candidates,
    actionableControlCount: actionable.length,
    truncated: actionable.length > candidates.length,
    droppedCount: actionable.length - candidates.length
  };
}

/**
 * The candidates a decision backend may choose from for one observation.
 *
 * Only a control the player can act on is a candidate: a disabled control is
 * not an action, and a text field is not something one click performs, so it
 * is left to a backend that can type rather than offered as a choice.
 */
export function buildVisualCandidates(
  observation: PlaytestVisualObservation
): readonly PlaytestVisualCandidate[] {
  return buildVisualCandidateSet(observation).candidates;
}

/**
 * The trace line for the candidate a decision chose.
 *
 * A decision carries an action rather than a candidate id, so the trace
 * resolves the action back to the candidate that offered it. An action that no
 * candidate offered has no explanation, and the helper says so instead of
 * inventing one.
 */
export function describeVisualCandidateChoice(
  candidates: readonly PlaytestVisualCandidate[],
  action: PlaytestVisualAction
): string | null {
  const candidate = candidates.find((option) =>
    sameAction(option.action, action)
  );
  return candidate === undefined ? null : candidate.description;
}

/**
 * The candidate id is the control's own id, reduced to the safe charset.
 *
 * The Core already gives every control an id in that charset, so the reduction
 * is the identity for a well-formed observation and the ids stay unique. An id
 * outside the charset is still reduced rather than refused, and a reduction
 * that would collide gets a numbered suffix so the option ids stay distinct.
 */
function candidateId(controlId: string, taken: ReadonlySet<string>): string {
  const base =
    controlId
      .replace(UNSAFE_ID_CHARACTERS, "-")
      .slice(0, MAX_CANDIDATE_ID_LENGTH) || "control";
  let id = base;
  let attempt = 2;
  while (taken.has(id)) {
    id = `${base.slice(0, MAX_CANDIDATE_ID_LENGTH - MAX_ID_SUFFIX_ROOM)}-${String(attempt)}`;
    attempt += 1;
  }
  return id;
}

/**
 * The sentence a decision backend reads to choose this control.
 *
 * The name is the Runtime's own redacted accessible name and the role is the
 * Runtime's own control role, so the sentence can say what the player sees
 * without carrying a raw value or a selector. It promises only what the
 * Runtime does -- one activation -- and never an effect the Runtime cannot
 * observe.
 */
function describeControl(control: PlaytestVisualControl): string {
  const prefix = `Activate the ${control.role} `;
  const name = readableName(control.name);
  if (name.length === 0) {
    return `${prefix.trimEnd()}.`;
  }
  const room = MAX_CANDIDATE_DESCRIPTION_LENGTH - prefix.length - 3;
  const shown =
    name.length <= room ? name : `${name.slice(0, Math.max(0, room - 1))}…`;
  return `${prefix}"${shown}".`;
}

/**
 * The accessible name as a sentence may quote it: no control characters, no
 * double quote of its own, and no surrounding whitespace.
 */
function readableName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replaceAll('"', "'")
    .trim();
}

/** The activation of one control, citing the observation it was seen in. */
function activateControl(
  observation: PlaytestVisualObservation,
  controlId: string
): PlaytestVisualAction {
  return {
    schema: PLAYTEST_VISUAL_ACTION_SCHEMA,
    workspaceId: observation.workspaceId,
    targetId: observation.targetId,
    episodeId: observation.episodeId,
    observationId: observation.observationId,
    kind: "activate-control",
    controlId
  };
}

/** Whether two actions are the same action on the same control or key. */
function sameAction(
  left: PlaytestVisualAction,
  right: PlaytestVisualAction
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "activate-control":
      return (
        right.kind === "activate-control" && left.controlId === right.controlId
      );
    case "pointer-click":
      return (
        right.kind === "pointer-click" &&
        left.frameArtifactId === right.frameArtifactId &&
        left.x === right.x &&
        left.y === right.y
      );
    case "key-press":
      return right.kind === "key-press" && left.key === right.key;
    case "gamepad-press":
      return right.kind === "gamepad-press" && left.button === right.button;
  }
}
