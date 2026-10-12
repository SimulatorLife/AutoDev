/**
 * Deterministic interpretation of native-capture state intervals.
 * Game/browser instrumentation supplies the intervals and versioned
 * precedence contract; Core only validates and resolves their overlap.
 */
export const PLAYTEST_NATIVE_TIMING_STATES = [
  "active-interaction",
  "required-animation",
  "deliberation",
  "idle",
  "unknown"
] as const;

export type PlaytestNativeTimingState =
  (typeof PLAYTEST_NATIVE_TIMING_STATES)[number];
type ObservableTimingState = Exclude<PlaytestNativeTimingState, "unknown">;

export interface PlaytestNativeTimingInterval {
  readonly state: PlaytestNativeTimingState;
  readonly startMs: number;
  readonly endMs: number;
  readonly precedenceVersion: string;
}

export interface PlaytestNativeTimingInput {
  /** Native capture duration only; never simulation or inference duration. */
  readonly durationMs: number;
  readonly precedenceVersion: string;
  /** Highest priority first; `unknown` is always resolved last. */
  readonly precedence: readonly ObservableTimingState[];
  readonly intervals: readonly PlaytestNativeTimingInterval[];
}

export interface PlaytestNativeTimingSummary {
  readonly durationMs: number;
  readonly precedenceVersion: string;
  readonly intervals: readonly PlaytestNativeTimingInterval[];
  readonly durationByStateMs: Readonly<
    Record<PlaytestNativeTimingState, number>
  >;
}

const OBSERVABLE_STATES = PLAYTEST_NATIVE_TIMING_STATES.filter(
  (state): state is ObservableTimingState => state !== "unknown"
);
const TIMING_STATE_SET = new Set<string>(PLAYTEST_NATIVE_TIMING_STATES);

function assertNativeTimingInput(input: PlaytestNativeTimingInput): void {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new TypeError(
      "Native timing duration must be finite and non-negative."
    );
  }
  if (!input.precedenceVersion.trim()) {
    throw new TypeError("Native timing precedenceVersion must be non-empty.");
  }
  const validPrecedence =
    input.precedence.length === OBSERVABLE_STATES.length &&
    new Set(input.precedence).size === OBSERVABLE_STATES.length &&
    OBSERVABLE_STATES.every((state) => input.precedence.includes(state));
  if (!validPrecedence) {
    throw new TypeError(
      "Native timing precedence must order each observable state exactly once."
    );
  }
  for (const interval of input.intervals) assertNativeInterval(input, interval);
}

function assertNativeInterval(
  input: PlaytestNativeTimingInput,
  interval: PlaytestNativeTimingInterval
): void {
  if (!TIMING_STATE_SET.has(interval.state)) {
    throw new TypeError("Native timing interval has an unsupported state.");
  }
  if (interval.precedenceVersion !== input.precedenceVersion) {
    throw new TypeError(
      "Native timing intervals must use the declared precedenceVersion."
    );
  }
  if (
    !Number.isFinite(interval.startMs) ||
    !Number.isFinite(interval.endMs) ||
    interval.startMs < 0 ||
    interval.endMs <= interval.startMs ||
    interval.endMs > input.durationMs
  ) {
    throw new TypeError(
      "Native timing intervals must be positive and within the capture duration."
    );
  }
}

interface BoundaryEvents {
  readonly starts: PlaytestNativeTimingInterval[];
  readonly ends: PlaytestNativeTimingInterval[];
}

function boundaryEvents(
  input: PlaytestNativeTimingInput
): Map<number, BoundaryEvents> {
  const events = new Map<number, BoundaryEvents>([
    [0, { starts: [], ends: [] }],
    [input.durationMs, { starts: [], ends: [] }]
  ]);
  for (const interval of input.intervals) {
    const start = events.get(interval.startMs) ?? { starts: [], ends: [] };
    start.starts.push(interval);
    events.set(interval.startMs, start);
    const end = events.get(interval.endMs) ?? { starts: [], ends: [] };
    end.ends.push(interval);
    events.set(interval.endMs, end);
  }
  return events;
}

function resolveIntervals(
  input: PlaytestNativeTimingInput
): PlaytestNativeTimingInterval[] {
  const events = boundaryEvents(input);
  const boundaries = [...events.keys()].sort((left, right) => left - right);
  const activeCounts = new Map<PlaytestNativeTimingState, number>(
    PLAYTEST_NATIVE_TIMING_STATES.map((state) => [state, 0])
  );
  const resolved: PlaytestNativeTimingInterval[] = [];

  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const startMs = boundaries[index]!;
    const endMs = boundaries[index + 1]!;
    const event = events.get(startMs)!;
    for (const interval of event.ends) {
      activeCounts.set(interval.state, activeCounts.get(interval.state)! - 1);
    }
    for (const interval of event.starts) {
      activeCounts.set(interval.state, activeCounts.get(interval.state)! + 1);
    }
    const state = winningState(input.precedence, activeCounts);
    appendInterval(resolved, state, startMs, endMs, input.precedenceVersion);
  }
  return resolved;
}

function winningState(
  precedence: readonly ObservableTimingState[],
  activeCounts: ReadonlyMap<PlaytestNativeTimingState, number>
): PlaytestNativeTimingState {
  return (
    precedence.find((state) => (activeCounts.get(state) ?? 0) > 0) ?? "unknown"
  );
}

function appendInterval(
  intervals: PlaytestNativeTimingInterval[],
  state: PlaytestNativeTimingState,
  startMs: number,
  endMs: number,
  precedenceVersion: string
): void {
  const previous = intervals.at(-1);
  if (previous?.state === state && previous.endMs === startMs) {
    intervals[intervals.length - 1] = { ...previous, endMs };
    return;
  }
  intervals.push({ state, startMs, endMs, precedenceVersion });
}

function durationsByState(
  intervals: readonly PlaytestNativeTimingInterval[]
): Record<PlaytestNativeTimingState, number> {
  const durations: Record<PlaytestNativeTimingState, number> = {
    "active-interaction": 0,
    "required-animation": 0,
    deliberation: 0,
    idle: 0,
    unknown: 0
  };
  for (const interval of intervals) {
    durations[interval.state] += interval.endMs - interval.startMs;
  }
  return durations;
}

/**
 * Resolves overlapping native UI-state observations using a game-versioned
 * precedence order. Uncovered time and explicit unknown observations remain
 * unknown. Invalid/out-of-range intervals fail rather than being clipped.
 */
export function summarizePlaytestNativeTiming(
  input: PlaytestNativeTimingInput
): PlaytestNativeTimingSummary {
  assertNativeTimingInput(input);
  const intervals = resolveIntervals(input);
  return {
    durationMs: input.durationMs,
    precedenceVersion: input.precedenceVersion,
    intervals,
    durationByStateMs: durationsByState(intervals)
  };
}
