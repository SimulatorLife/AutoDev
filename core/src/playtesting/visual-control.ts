/**
 * Safe, game-neutral contracts for rendered-UI observations and discrete input.
 *
 * Visual evidence carries only a bounded still-frame reference and visible
 * semantic controls; it never carries page HTML, form values, or selectors.
 * Runtime must build each observation from a fresh browser read, redact before
 * persistence/model exposure, and resolve semantic control IDs again at the
 * input boundary.
 */
import {
  assertWorkspaceVisualPlaytestTargetApproval,
  WORKSPACE_VISUAL_PLAYTEST_INPUTS,
  type WorkspaceVisualPlaytestInput,
  type WorkspaceVisualPlaytestTargetApproval
} from "../workspaces/visual-playtesting.ts";
import type { PlaytestArtifactReference } from "./protocol-types.ts";

export const PLAYTEST_VISUAL_OBSERVATION_SCHEMA =
  "autodev-playtest-visual-observation-v1" as const;
export const PLAYTEST_VISUAL_ACTION_SCHEMA =
  "autodev-playtest-visual-action-v1" as const;

export const PLAYTEST_VISUAL_CONTROL_ROLES = [
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
  "textbox",
  "combobox"
] as const;

export type PlaytestVisualControlRole =
  (typeof PLAYTEST_VISUAL_CONTROL_ROLES)[number];

export const PLAYTEST_VISUAL_SAFE_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Space",
  "Escape",
  "Tab",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD"
] as const;

export type PlaytestVisualSafeKey = (typeof PLAYTEST_VISUAL_SAFE_KEYS)[number];

export const PLAYTEST_VISUAL_GAMEPAD_BUTTONS = [
  "a",
  "b",
  "x",
  "y",
  "lb",
  "rb",
  "lt",
  "rt",
  "start",
  "select",
  "dpad-up",
  "dpad-down",
  "dpad-left",
  "dpad-right"
] as const;

export type PlaytestVisualGamepadButton =
  (typeof PLAYTEST_VISUAL_GAMEPAD_BUTTONS)[number];

export interface PlaytestVisualViewport {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

export interface PlaytestVisualBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A sanitized control currently visible to the player. */
export interface PlaytestVisualControl {
  readonly controlId: string;
  readonly role: PlaytestVisualControlRole;
  /** Accessible name after Runtime redaction; never a raw value or selector. */
  readonly name: string;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly inputKind: "none" | "text-entry" | "password";
  readonly bounds: PlaytestVisualBounds;
}

export interface PlaytestVisualObservation {
  readonly schema: typeof PLAYTEST_VISUAL_OBSERVATION_SCHEMA;
  readonly observationId: string;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly episodeId: string;
  /** Origin only: paths, query values, and fragments are intentionally absent. */
  readonly origin: string;
  readonly capturedAt: string;
  readonly viewport: PlaytestVisualViewport;
  readonly frame: PlaytestArtifactReference;
  /** Runtime records whether any image/visible text was redacted before storage. */
  readonly privacyState: "clear" | "redacted";
  readonly controls: readonly PlaytestVisualControl[];
  readonly visibleWarnings: readonly string[];
  readonly phaseEvidence: string | null;
  readonly progressEvidence: string | null;
}

interface PlaytestVisualActionBase {
  readonly schema: typeof PLAYTEST_VISUAL_ACTION_SCHEMA;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly episodeId: string;
  /** Every action is admitted against the exact fresh observation it cites. */
  readonly observationId: string;
}

export type PlaytestVisualAction =
  | (PlaytestVisualActionBase & {
      readonly kind: "activate-control";
      readonly controlId: string;
    })
  | (PlaytestVisualActionBase & {
      readonly kind: "pointer-click";
      readonly frameArtifactId: string;
      readonly x: number;
      readonly y: number;
    })
  | (PlaytestVisualActionBase & {
      readonly kind: "key-press";
      readonly key: PlaytestVisualSafeKey;
    })
  | (PlaytestVisualActionBase & {
      readonly kind: "gamepad-press";
      readonly button: PlaytestVisualGamepadButton;
    });

/**
 * The refusal that says the observation no longer describes the page.
 *
 * The observation aged out, or the page moved under it: the origin, the
 * viewport, the frame or the session is not the one the decision was taken
 * from.
 */
export const PLAYTESTS_STALE_OBSERVATION_REFUSAL = "stale-observation" as const;

/**
 * The refusal that says the page no longer offers the control the
 * observation promised.
 *
 * The control is gone, disabled, or no longer the same control.
 */
export const PLAYTESTS_CONTROL_CHANGED_REFUSAL = "control-changed" as const;

export type PlaytestVisualActionAdmissionReason =
  | "unsupported-target"
  | "target-revoked"
  | "session-mismatch"
  | "origin-not-approved"
  | typeof PLAYTESTS_STALE_OBSERVATION_REFUSAL
  | "viewport-changed"
  | "input-not-approved"
  | "input-unsupported"
  | "control-unavailable"
  | "sensitive-control"
  | "frame-mismatch"
  | "coordinate-out-of-bounds"
  | "text-entry-not-supported";

export type PlaytestVisualActionAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly reason: PlaytestVisualActionAdmissionReason;
    };

/**
 * Why the Runtime refused to dispatch an action.
 *
 * The admission rules above answer for the action that was asked for, and the
 * browser driver answers for the game as it is now: the control is gone, the
 * page needs setup before it can be played, the screen holds something the
 * Runtime cannot redact, or the episode has spent a budget. Both owners share
 * one vocabulary, because the episode's next move depends on which of these
 * it is.
 */
export type PlaytestVisualActionRefusalReason =
  | PlaytestVisualActionAdmissionReason
  | "auth-or-setup-required"
  | "sensitive-visual-unredactable"
  | "action-budget-exhausted"
  | "wall-time-limit"
  | "driver-state-unavailable"
  | typeof PLAYTESTS_CONTROL_CHANGED_REFUSAL
  | "event-budget-exhausted";

/**
 * Whether a refusal says the page moved under the observation.
 *
 * Two owners answer with a refusal: the admission rules above, and the
 * browser driver, which refuses a control that the page no longer offers as
 * the observation promised. Both say the same thing about the episode -- the
 * thing the policy looked at is not what the page offers now -- and both are
 * answered by looking again: the control may still be there, somewhere else,
 * or in a different state.
 *
 * Every other refusal is terminal. A refusal that says the action was not
 * allowed, that the game needs setup, or that the episode is out of budget
 * does not change because the page was read again.
 */
export function playtestActionRefusalMeansPageMoved(
  reason: PlaytestVisualActionRefusalReason
): boolean {
  return (
    reason === PLAYTESTS_CONTROL_CHANGED_REFUSAL ||
    reason === PLAYTESTS_STALE_OBSERVATION_REFUSAL
  );
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const FRAME_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const TEXT_CONTROL_ROLES = new Set<PlaytestVisualControlRole>([
  "textbox",
  "combobox"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validBounds(
  value: unknown,
  viewport: PlaytestVisualViewport
): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["x", "y", "width", "height"]) ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.width) ||
    !isFiniteNumber(value.height) ||
    value.width <= 0 ||
    value.height <= 0 ||
    value.x < 0 ||
    value.y < 0
  ) {
    return false;
  }
  return (
    value.x + value.width <= viewport.width &&
    value.y + value.height <= viewport.height
  );
}

function validViewport(value: unknown): value is PlaytestVisualViewport {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["width", "height", "deviceScaleFactor"]) &&
    Number.isSafeInteger(value.width) &&
    Number(value.width) > 0 &&
    Number(value.width) <= 16_384 &&
    Number.isSafeInteger(value.height) &&
    Number(value.height) > 0 &&
    Number(value.height) <= 16_384 &&
    isFiniteNumber(value.deviceScaleFactor) &&
    value.deviceScaleFactor >= 0.25 &&
    value.deviceScaleFactor <= 8
  );
}

function validArtifactReference(value: unknown, maxBytes: number): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["artifactId", "sha256", "bytes", "mediaType", "revision"].includes(key)
    ) &&
    typeof value.artifactId === "string" &&
    ID_PATTERN.test(value.artifactId) &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) > 0 &&
    Number(value.bytes) <= maxBytes &&
    typeof value.mediaType === "string" &&
    FRAME_MEDIA_TYPES.has(value.mediaType) &&
    (value.revision === undefined ||
      (Number.isSafeInteger(value.revision) && Number(value.revision) >= 0))
  );
}

function assertVisualControl(
  value: unknown,
  viewport: PlaytestVisualViewport
): asserts value is PlaytestVisualControl {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "controlId",
      "role",
      "name",
      "enabled",
      "focused",
      "inputKind",
      "bounds"
    ]) ||
    typeof value.controlId !== "string" ||
    !ID_PATTERN.test(value.controlId) ||
    !(PLAYTEST_VISUAL_CONTROL_ROLES as readonly unknown[]).includes(
      value.role
    ) ||
    !isText(value.name, 256) ||
    typeof value.enabled !== "boolean" ||
    typeof value.focused !== "boolean" ||
    !["none", "text-entry", "password"].includes(String(value.inputKind)) ||
    !validBounds(value.bounds, viewport)
  ) {
    throw new TypeError("Visual observation contains an invalid control.");
  }
  if (
    (TEXT_CONTROL_ROLES.has(value.role as PlaytestVisualControlRole) &&
      value.inputKind === "none") ||
    (!TEXT_CONTROL_ROLES.has(value.role as PlaytestVisualControlRole) &&
      value.inputKind !== "none")
  ) {
    throw new TypeError("Visual control role and input kind do not agree.");
  }
}

/** Validate a player-visible observation before storage or model exposure. */
export function assertPlaytestVisualObservation(
  value: unknown,
  target: WorkspaceVisualPlaytestTargetApproval
): asserts value is PlaytestVisualObservation {
  assertWorkspaceVisualPlaytestTargetApproval(target);
  const fields = [
    "schema",
    "observationId",
    "workspaceId",
    "targetId",
    "episodeId",
    "origin",
    "capturedAt",
    "viewport",
    "frame",
    "privacyState",
    "controls",
    "visibleWarnings",
    "phaseEvidence",
    "progressEvidence"
  ];
  if (!isRecord(value) || !hasOnlyKeys(value, fields)) {
    throw new TypeError("Visual observation has an unsupported shape.");
  }
  const viewport = value.viewport;
  if (
    value.schema !== PLAYTEST_VISUAL_OBSERVATION_SCHEMA ||
    typeof value.observationId !== "string" ||
    !ID_PATTERN.test(value.observationId) ||
    value.workspaceId !== target.workspaceId ||
    value.targetId !== target.targetId ||
    !isText(value.episodeId, 128) ||
    typeof value.origin !== "string" ||
    !target.allowedOrigins.includes(value.origin) ||
    !isText(value.capturedAt, 40) ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    new Date(value.capturedAt).toISOString() !== value.capturedAt ||
    !validViewport(viewport) ||
    !validArtifactReference(
      value.frame,
      target.limits.artifactBytesPerEpisode
    ) ||
    (value.privacyState !== "clear" && value.privacyState !== "redacted") ||
    !Array.isArray(value.controls) ||
    value.controls.length > 256 ||
    !Array.isArray(value.visibleWarnings) ||
    value.visibleWarnings.length > 64 ||
    !value.visibleWarnings.every((warning) => isText(warning, 256)) ||
    (value.phaseEvidence !== null && !isText(value.phaseEvidence, 512)) ||
    (value.progressEvidence !== null && !isText(value.progressEvidence, 512))
  ) {
    throw new TypeError("Visual observation fields are invalid.");
  }
  const controls = value.controls as unknown[];
  const controlIds = new Set<string>();
  let focusedCount = 0;
  for (const control of controls) {
    assertVisualControl(control, viewport);
    if (controlIds.has(control.controlId)) {
      throw new TypeError("Visual observation contains duplicate control IDs.");
    }
    if (control.focused) focusedCount += 1;
    controlIds.add(control.controlId);
  }
  if (focusedCount > 1) {
    throw new TypeError(
      "Visual observation has more than one focused control."
    );
  }
}

/** Validate one bounded, non-text-entry visual action. */
export function assertPlaytestVisualAction(
  value: unknown
): asserts value is PlaytestVisualAction {
  if (!isRecord(value) || value.schema !== PLAYTEST_VISUAL_ACTION_SCHEMA) {
    throw new TypeError("Visual action has an unsupported schema.");
  }
  if (
    typeof value.workspaceId !== "string" ||
    !WORKSPACE_ID_PATTERN.test(value.workspaceId) ||
    typeof value.targetId !== "string" ||
    !ID_PATTERN.test(value.targetId) ||
    !isText(value.episodeId, 128) ||
    typeof value.observationId !== "string" ||
    !ID_PATTERN.test(value.observationId)
  ) {
    throw new TypeError("Visual action must cite an observation.");
  }
  switch (value.kind) {
    case "activate-control": {
      if (
        !hasOnlyKeys(value, [
          "schema",
          "workspaceId",
          "targetId",
          "episodeId",
          "observationId",
          "kind",
          "controlId"
        ]) ||
        typeof value.controlId !== "string" ||
        !ID_PATTERN.test(value.controlId)
      ) {
        throw new TypeError("Semantic visual action is malformed.");
      }
      return;
    }
    case "pointer-click": {
      if (
        !hasOnlyKeys(value, [
          "schema",
          "workspaceId",
          "targetId",
          "episodeId",
          "observationId",
          "kind",
          "frameArtifactId",
          "x",
          "y"
        ]) ||
        typeof value.frameArtifactId !== "string" ||
        !ID_PATTERN.test(value.frameArtifactId) ||
        !isFiniteNumber(value.x) ||
        !isFiniteNumber(value.y)
      ) {
        throw new TypeError("Coordinate visual action is malformed.");
      }
      return;
    }
    case "key-press": {
      if (
        !hasOnlyKeys(value, [
          "schema",
          "workspaceId",
          "targetId",
          "episodeId",
          "observationId",
          "kind",
          "key"
        ]) ||
        !(PLAYTEST_VISUAL_SAFE_KEYS as readonly unknown[]).includes(value.key)
      ) {
        throw new TypeError("Visual key action is malformed.");
      }
      return;
    }
    case "gamepad-press": {
      if (
        !hasOnlyKeys(value, [
          "schema",
          "workspaceId",
          "targetId",
          "episodeId",
          "observationId",
          "kind",
          "button"
        ]) ||
        !(PLAYTEST_VISUAL_GAMEPAD_BUTTONS as readonly unknown[]).includes(
          value.button
        )
      ) {
        throw new TypeError("Visual gamepad action is malformed.");
      }
      return;
    }
    default: {
      throw new TypeError("Visual action kind is unsupported.");
    }
  }
}

export interface PlaytestVisualActionAdmissionInput {
  readonly target: WorkspaceVisualPlaytestTargetApproval;
  readonly observation: PlaytestVisualObservation;
  readonly action: PlaytestVisualAction;
  /** Actual driver support; grants alone must never imply a tool is installed. */
  readonly runtimeSupportedInputs: readonly WorkspaceVisualPlaytestInput[];
  /** The live page facts re-read immediately before dispatch. */
  readonly currentOrigin: string;
  readonly currentViewport: PlaytestVisualViewport;
  readonly nowMs: number;
  /** Set from a measured workload-specific freshness budget; no magic default. */
  readonly maxObservationAgeMs: number;
}

function sameViewport(
  left: PlaytestVisualViewport,
  right: PlaytestVisualViewport
): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.deviceScaleFactor === right.deviceScaleFactor
  );
}

function controlAt(
  observation: PlaytestVisualObservation,
  x: number,
  y: number
): PlaytestVisualControl | undefined {
  return observation.controls.find(
    (control) =>
      x >= control.bounds.x &&
      x <= control.bounds.x + control.bounds.width &&
      y >= control.bounds.y &&
      y <= control.bounds.y + control.bounds.height
  );
}

/** Deterministic permission/freshness gate immediately before browser input. */
export function admitPlaytestVisualAction(
  input: PlaytestVisualActionAdmissionInput
): PlaytestVisualActionAdmission {
  assertWorkspaceVisualPlaytestTargetApproval(input.target);
  assertPlaytestVisualObservation(input.observation, input.target);
  assertPlaytestVisualAction(input.action);
  assertValidFreshnessBudget(input);
  assertValidRuntimeInputCapabilities(input);
  const reason =
    targetGateReason(input) ??
    inputCapabilityReason(input) ??
    actionKindReason(input.action, input.observation);
  if (reason !== null) {
    return { admitted: false, reason };
  }
  return { admitted: true };
}

function assertValidFreshnessBudget(
  input: PlaytestVisualActionAdmissionInput
): void {
  if (
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isSafeInteger(input.maxObservationAgeMs) ||
    input.maxObservationAgeMs <= 0 ||
    input.maxObservationAgeMs > input.target.limits.wallTimeMs
  ) {
    throw new TypeError("Visual action freshness budget is invalid.");
  }
}

function assertValidRuntimeInputCapabilities(
  input: PlaytestVisualActionAdmissionInput
): void {
  if (
    !Array.isArray(input.runtimeSupportedInputs) ||
    input.runtimeSupportedInputs.some(
      (capability) =>
        !(WORKSPACE_VISUAL_PLAYTEST_INPUTS as readonly string[]).includes(
          capability
        )
    ) ||
    new Set(input.runtimeSupportedInputs).size !==
      input.runtimeSupportedInputs.length
  ) {
    throw new TypeError("Runtime visual input capabilities are invalid.");
  }
}

/** Target, session, origin, freshness and viewport gates, in admission order. */
function targetGateReason(
  input: PlaytestVisualActionAdmissionInput
): PlaytestVisualActionAdmissionReason | null {
  if (input.target.revokedAt !== null) {
    return "target-revoked";
  }
  if (
    input.target.entryRequirements !== "none" ||
    input.target.controlTimingClass === "continuous"
  ) {
    return "unsupported-target";
  }
  if (
    input.action.workspaceId !== input.observation.workspaceId ||
    input.action.targetId !== input.observation.targetId ||
    input.action.episodeId !== input.observation.episodeId ||
    input.target.workspaceId !== input.observation.workspaceId ||
    input.target.targetId !== input.observation.targetId
  ) {
    return "session-mismatch";
  }
  if (!input.target.allowedOrigins.includes(input.currentOrigin)) {
    return "origin-not-approved";
  }
  if (input.currentOrigin !== input.observation.origin) {
    return PLAYTESTS_STALE_OBSERVATION_REFUSAL;
  }
  if (input.action.observationId !== input.observation.observationId) {
    return PLAYTESTS_STALE_OBSERVATION_REFUSAL;
  }
  const age = input.nowMs - Date.parse(input.observation.capturedAt);
  if (age < 0 || age > input.maxObservationAgeMs) {
    return PLAYTESTS_STALE_OBSERVATION_REFUSAL;
  }
  if (!sameViewport(input.currentViewport, input.observation.viewport)) {
    return "viewport-changed";
  }
  return null;
}

/** Granted-input gates: the target grant first, then the live driver support. */
function inputCapabilityReason(
  input: PlaytestVisualActionAdmissionInput
): PlaytestVisualActionAdmissionReason | null {
  const requiredInput = actionInput(input.action);
  if (!input.target.inputCapabilities.includes(requiredInput)) {
    return "input-not-approved";
  }
  if (!input.runtimeSupportedInputs.includes(requiredInput)) {
    return "input-unsupported";
  }
  return null;
}

/** Action-kind gates; each kind owns its own control, frame and focus checks. */
function actionKindReason(
  action: PlaytestVisualAction,
  observation: PlaytestVisualObservation
): PlaytestVisualActionAdmissionReason | null {
  if (action.kind === "activate-control") {
    return activateControlReason(action, observation);
  }
  if (action.kind === "pointer-click") {
    return pointerClickReason(action, observation);
  }
  if (action.kind === "key-press") {
    return keyPressReason(observation);
  }
  return null;
}

function activateControlReason(
  action: Extract<PlaytestVisualAction, { readonly kind: "activate-control" }>,
  observation: PlaytestVisualObservation
): PlaytestVisualActionAdmissionReason | null {
  const control = observation.controls.find(
    ({ controlId }) => controlId === action.controlId
  );
  if (!control || !control.enabled) {
    return "control-unavailable";
  }
  if (control.inputKind !== "none" || TEXT_CONTROL_ROLES.has(control.role)) {
    return "sensitive-control";
  }
  return null;
}

function pointerClickReason(
  action: Extract<PlaytestVisualAction, { readonly kind: "pointer-click" }>,
  observation: PlaytestVisualObservation
): PlaytestVisualActionAdmissionReason | null {
  if (action.frameArtifactId !== observation.frame.artifactId) {
    return "frame-mismatch";
  }
  if (
    action.x < 0 ||
    action.y < 0 ||
    action.x >= observation.viewport.width ||
    action.y >= observation.viewport.height
  ) {
    return "coordinate-out-of-bounds";
  }
  const control = controlAt(observation, action.x, action.y);
  if (control && !control.enabled) {
    return "control-unavailable";
  }
  if (control?.inputKind !== undefined && control.inputKind !== "none") {
    return "sensitive-control";
  }
  return null;
}

function keyPressReason(
  observation: PlaytestVisualObservation
): PlaytestVisualActionAdmissionReason | null {
  const focusedControl = observation.controls.find(
    ({ focused: isFocused }) => isFocused
  );
  if (
    focusedControl?.inputKind === "password" ||
    focusedControl?.inputKind === "text-entry"
  ) {
    return "text-entry-not-supported";
  }
  return null;
}

/** The input device each action kind needs, so grants can name one. */
const ACTION_INPUT_BY_KIND: Readonly<
  Record<PlaytestVisualAction["kind"], "keyboard" | "pointer" | "gamepad">
> = {
  "activate-control": "pointer",
  "pointer-click": "pointer",
  "key-press": "keyboard",
  "gamepad-press": "gamepad"
};

function actionInput(
  action: PlaytestVisualAction
): "keyboard" | "pointer" | "gamepad" {
  return ACTION_INPUT_BY_KIND[action.kind];
}
