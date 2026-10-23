/**
 * The Runtime's measurement of whether the game is advancing.
 *
 * A visual episode can go on for a long time without the player seeing
 * anything happen: a button that does nothing, a screen that never changes,
 * a loop the game keeps walking. The episode's own budgets (steps, tokens,
 * wall time) bound how long that can go on, but they do not say *why* the run
 * ended, and a run that spends its whole budget on a frozen game is
 * indistinguishable from a run that was making progress right up to the end.
 *
 * This module owns the reading. It is a pure function over two observations:
 * what the page showed before, and what it shows now. The Runtime measures
 * the run against it; the decision backend is told what it says, so a backend
 * that can choose differently is told *that* it should.
 *
 * Infrastructure-free: no Runtime/Data/Console imports, no network, no
 * filesystem.
 */

import type { WorkspaceVisualPlaytestProgressPolicy } from "../workspaces/visual-playtesting.ts";
import type { PlaytestVisualObservation } from "./visual-control.ts";

/**
 * The version of the progress contract.
 *
 * The reading is recorded with the step it belongs to, so a reader can tell
 * which reading produced it. A change to what counts as progress is a new
 * version, not a silent redefinition.
 */
export const PLAYTESTS_VISUAL_PROGRESS_VERSION =
  "playtest-visual-progress-v1" as const;

/**
 * The warning a page carries while it is still loading.
 *
 * A loading page is not a stuck page: the game has not had the chance to
 * advance yet, so the step does not count against the no-progress budget.
 */
export const PLAYTESTS_VISUAL_LOADING_WARNING =
  "The page reports that it is still loading." as const;

/**
 * The semantic state of the game as one observation reports it.
 *
 * The state is what the *player* can see: the screen the page is showing, the
 * progress it reports, and the controls it offers. It deliberately leaves out
 * the frame, the geometry and every other fact that changes while a game
 * animates, so an animation does not read as progress and a repaint does not
 * reset the measurement.
 */
export interface PlaytestVisualProgressState {
  readonly version: typeof PLAYTESTS_VISUAL_PROGRESS_VERSION;
  /** The screen the page is showing, or null when it names none. */
  readonly phase: string | null;
  /** The progress the page reports, or null when it reports none. */
  readonly progress: string | null;
  /** The identities of the controls the page offers to the player. */
  readonly controls: readonly string[];
  /** Whether the page reports that it is still loading. */
  readonly loading: boolean;
}

/**
 * What the game did between two observations.
 *
 * "advanced" is the game showing the player something new, "unchanged" is the
 * game showing the player exactly what it showed before, and "loading" is the
 * game not being ready to be judged yet.
 */
export type PlaytestVisualProgressOutcome =
  | "advanced"
  | "unchanged"
  | "loading";

/**
 * The progress state one observation reports.
 *
 * The control identities are the observation's own control ids, which the
 * driver derives from the control's content (its role, its name and its input
 * kind) rather than from where it sits on the page. A control that moved is
 * the same control; a control whose label changed is a different one, and the
 * player can see that difference.
 */
export function playtestVisualProgressState(
  observation: PlaytestVisualObservation
): PlaytestVisualProgressState {
  return {
    version: PLAYTESTS_VISUAL_PROGRESS_VERSION,
    phase: observation.phaseEvidence,
    progress: observation.progressEvidence,
    controls: observation.controls
      .filter((control) => control.enabled)
      .map((control) => control.controlId)
      .slice()
      .sort(),
    loading: observation.visibleWarnings.includes(
      PLAYTESTS_VISUAL_LOADING_WARNING
    )
  };
}

/**
 * What the game did between two observations.
 *
 * The first observation of an episode has nothing to be compared with, so it
 * counts as an advance: the run has started.
 */
export function playtestVisualProgressOutcome(
  previous: PlaytestVisualProgressState | null,
  current: PlaytestVisualProgressState
): PlaytestVisualProgressOutcome {
  if (current.loading) return "loading";
  if (previous === null) return "advanced";
  if (previous.phase !== current.phase) return "advanced";
  if (previous.progress !== current.progress) return "advanced";
  if (!sameControls(previous.controls, current.controls)) return "advanced";
  return "unchanged";
}

/**
 * Whether the episode has gone without the game advancing for longer than the
 * approved thresholds allow.
 *
 * The thresholds are the operator's, and the measurement is the Runtime's.
 * An episode that has not advanced for that long is not going to advance on
 * its own: the episode ends and says so, instead of spending the rest of its
 * budget on a game that is not responding.
 */
export function playtestVisualProgressStuck(input: {
  readonly unchangedSteps: number;
  readonly unchangedMs: number;
  readonly policy: WorkspaceVisualPlaytestProgressPolicy;
}): boolean {
  return (
    input.unchangedSteps >= input.policy.maxUnchangedDecisions ||
    input.unchangedMs >= input.policy.maxUnchangedMs
  );
}

/**
 * Whether two control lists name the same controls.
 *
 * The lists are sorted, so this is a set comparison: the order the page
 * happened to list the controls in is not part of the state.
 */
function sameControls(
  previous: readonly string[],
  current: readonly string[]
): boolean {
  if (previous.length !== current.length) return false;
  for (const [index, controlId] of previous.entries()) {
    if (current[index] !== controlId) return false;
  }
  return true;
}
