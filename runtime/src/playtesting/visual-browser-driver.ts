/** Restricted transient browser driver used by Runtime visual sessions. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  admitPlaytestVisualAction,
  assertPlaytestVisualObservation,
  assertWorkspaceVisualPlaytestTargetApproval,
  PLAYTEST_VISUAL_OBSERVATION_SCHEMA,
  type PlaytestVisualAction,
  type PlaytestVisualActionAdmissionReason,
  type PlaytestVisualControl,
  type PlaytestVisualObservation,
  type PlaytestVisualViewport,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page
} from "playwright-core";

import {
  PLAYESTS_ARTIFACT_MAX_WINDOW_STEPS,
  type PlaytestArtifactStore,
  PLAYTESTS_ARTIFACT_MAX_BYTES
} from "./artifact-store.ts";
import { withoutControlCharacters } from "./recorded-text.ts";

function resolveChromiumExecutablePath(
  browserType: Pick<typeof chromium, "executablePath">
): string | null {
  try {
    const candidate = browserType.executablePath();
    if (existsSync(candidate)) return candidate;
  } catch {
    // Fall back to scanning standard host locations.
  }
  const cacheRoots = [
    path.join(homedir(), "Library", "Caches", "ms-playwright"),
    "/Users/henrykirk/Library/Caches/ms-playwright",
    path.join(homedir(), ".cache", "ms-playwright")
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    try {
      const entries = readdirSync(root)
        .filter((entry) => entry.startsWith("chromium-"))
        .sort()
        .reverse();
      for (const entry of entries) {
        const candidates = [
          path.join(
            root,
            entry,
            "chrome-mac-arm64",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing"
          ),
          path.join(
            root,
            entry,
            "chrome-mac",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing"
          ),
          path.join(root, entry, "chrome-linux", "chrome")
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // Ignore unreadable cache directory.
    }
  }
  return null;
}

let cachedChromiumAvailability: boolean | null = null;

/**
 * Cached, no-launch check for whether a Playwright Chromium executable is
 * resolvable on this host. Readiness probes must call this instead of
 * opening a browser per request; the result is memoized for the process
 * lifetime since the installed browser binary does not change between
 * requests. Call {@link resetPlaytestVisualBrowserDriverAvailabilityCache}
 * in tests that need to force re-resolution.
 */
export function isPlaytestVisualBrowserDriverAvailable(
  browserType: Pick<typeof chromium, "executablePath"> = chromium
): boolean {
  if (cachedChromiumAvailability === null) {
    cachedChromiumAvailability =
      resolveChromiumExecutablePath(browserType) !== null;
  }
  return cachedChromiumAvailability;
}

/** Test-only seam: forces the next availability check to re-resolve. */
export function resetPlaytestVisualBrowserDriverAvailabilityCache(): void {
  cachedChromiumAvailability = null;
}

const CONTROL_SELECTOR =
  'button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="textbox"],[role="combobox"]';
const MASK_SELECTOR =
  'input,textarea,[contenteditable="true"],[data-sensitive="true"],[autocomplete^="cc-"]';
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
/**
 * The same address, read without the global flag.
 *
 * A detection asks whether the text holds an address at all, and a global
 * pattern would carry the position of its last match into the next read.
 */
const SENSITIVE_EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
/** The fewest digits that read as one card number. */
const CARD_NUMBER_MIN_DIGITS = 13;
/** The most digits that read as one card number. */
const CARD_NUMBER_MAX_DIGITS = 19;
/** The whitespace the words of an attribute are separated by. */
const WHITESPACE_PATTERN = /\s+/u;
/** The autocomplete values that mark a field as a password field. */
const PASSWORD_AUTOCOMPLETE_PATTERN = /(?:current|new)-password/iu;
const SUPPORTED_INPUTS = ["keyboard", "pointer"] as const;
/** How often the driver checks whether the game has painted. */
const RENDER_WAIT_POLL_MS = 250;
/**
 * How long the driver waits for a game to paint before it captures anyway.
 *
 * It is a bound, not a delay: a game that paints in two seconds is captured
 * as soon as it has painted, and a game that never paints costs the episode
 * only this much.
 */
const DEFAULT_RENDER_WAIT_MS = 10_000;
/**
 * How long the driver waits for a browser it has to abandon to go away.
 *
 * A browser that cannot be closed must not hold the episode: the open has
 * already failed, and the episode still has to report that failure. The wait
 * is bounded so a wedged browser costs the episode this much and no more.
 */
const BROWSER_CLOSE_TIMEOUT_MS = 5000;
const VISUAL_EVENT_SCHEMA = "autodev-playtest-visual-event-v1" as const;

interface RawControl {
  readonly index: number;
  readonly role: PlaytestVisualControl["role"];
  readonly name: string;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly inputKind: "none" | "text-entry" | "password";
  /** Private-only destination origin for link admission; never model-visible. */
  readonly navigationOrigin: string | null;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** What the page itself reports when the driver reads it. */
interface RawPageReport {
  readonly controls: readonly RawControl[];
  readonly passwordVisible: boolean;
  readonly truncatedControls: boolean;
}

/** What the driver reads from the page, with its own verdict on the text. */
interface RawPageRead extends RawPageReport {
  readonly sensitiveTextVisible: boolean;
}

export type PlaytestVisualObservationBlockReason =
  | "auth-or-setup-required"
  | "sensitive-visual-unredactable"
  | "capture-budget-exhausted"
  | "event-budget-exhausted"
  | "wall-time-limit"
  | "origin-escape";

/** The game left the origin the operator approved. */
const ORIGIN_ESCAPE = "origin-escape";
/** The episode spent the wall time the operator approved. */
const WALL_TIME_LIMIT = "wall-time-limit";
/** The episode spent the event window the operator approved. */
const EVENT_BUDGET_EXHAUSTED = "event-budget-exhausted";
/** The screen holds something the Runtime cannot redact. */
const SENSITIVE_VISUAL_UNREDACTABLE = "sensitive-visual-unredactable";
/** The action would take the game outside the approved origin. */
const ORIGIN_NOT_APPROVED = "origin-not-approved";

export type PlaytestVisualObservationResult =
  | {
      readonly status: "observed";
      readonly observation: PlaytestVisualObservation;
    }
  | {
      readonly status: "blocked";
      readonly reason: PlaytestVisualObservationBlockReason;
    };

export type PlaytestVisualActionReceipt =
  | {
      readonly status: "dispatched";
      readonly step: number;
      readonly observationId: string;
      readonly actionKind: PlaytestVisualAction["kind"];
      readonly dispatchedAt: string;
      readonly driverDurationMs: number;
      /** Dispatch acknowledgement is not proof the game accepted the action. */
      readonly gameAcknowledgement: "not-observed";
    }
  | {
      readonly status: "refused";
      readonly step: number;
      readonly reason:
        | PlaytestVisualActionAdmissionReason
        | "action-budget-exhausted"
        | "wall-time-limit"
        | "driver-state-unavailable"
        | "control-changed"
        | "event-budget-exhausted";
    };

export interface PlaytestVisualBrowserDriverOptions {
  readonly target: WorkspaceVisualPlaytestTargetApproval;
  readonly episodeId: string;
  readonly artifacts: PlaytestArtifactStore;
  readonly viewport: PlaytestVisualViewport;
  /** Workload-selected; no implicit or magic action timeout. */
  readonly actionTimeoutMs: number;
  readonly maxSteps: number;
  /** Bound on how long the driver waits for the game to paint. */
  readonly renderWaitMs?: number;
  readonly now?: () => number;
  readonly id?: () => string;
  readonly browserType?: Pick<typeof chromium, "launch" | "executablePath">;
}

/**
 * The browser surface one visual episode needs.
 *
 * The real driver implements it. The episode loop talks to this interface
 * rather than to the concrete browser, so its budget accounting and its
 * failure classification — the parts that decide whether a slow model
 * truncates an episode or fails it — are exercisable without a browser.
 */
export interface PlaytestVisualEpisodeDriver {
  observe(): Promise<PlaytestVisualObservationResult>;
  act(action: PlaytestVisualAction): Promise<PlaytestVisualActionReceipt>;
  close(): Promise<unknown>;
  /** Milliseconds left in the approved per-episode wall-time budget. */
  remainingWallTimeMs(): number;
}

/** Opens the browser driver for one visual episode. Overridable for tests. */
export type PlaytestVisualDriverOpener = (
  options: PlaytestVisualBrowserDriverOptions
) => Promise<PlaytestVisualEpisodeDriver>;

export interface PlaytestVisualBrowserTelemetry {
  readonly schema: "autodev-playtest-visual-telemetry-v1";
  readonly version: 1;
  readonly inputAttempts: number;
  readonly inputValidated: number;
  readonly inputDispatched: number;
  readonly inputAcknowledged: 0;
  readonly inputRejected: number;
  readonly driverToolCalls: {
    readonly observe: number;
    readonly act: number;
  };
  readonly captureCount: number;
  readonly capturedBytes: number;
  readonly blockedRequestCount: number;
  readonly coverage: "complete" | "partial";
}

export interface PlaytestVisualBrowserEvent {
  readonly schema: typeof VISUAL_EVENT_SCHEMA;
  readonly eventId: string;
  readonly sequence: number;
  readonly episodeId: string;
  readonly type:
    | "browser-started"
    | "frame-captured"
    | "input-dispatched"
    | "input-refused"
    | "cross-origin-blocked"
    | "popup-blocked"
    | "browser-closed";
  readonly occurredAt: string;
  readonly step: number | null;
  readonly observationId: string | null;
  readonly frameArtifactId: string | null;
  readonly actionKind: PlaytestVisualAction["kind"] | null;
  readonly refusalReason: string | null;
  readonly blockedRequestCount: number;
}

type ActionRefusalReason =
  | PlaytestVisualActionAdmissionReason
  | "auth-or-setup-required"
  | "sensitive-visual-unredactable"
  | "action-budget-exhausted"
  | "wall-time-limit"
  | "driver-state-unavailable"
  | "control-changed"
  | "event-budget-exhausted";

export class PlaytestVisualBrowserDriverError extends Error {
  readonly code:
    | "driver-unavailable"
    | "target-not-runnable"
    | "source-unavailable"
    | "browser-open-timeout"
    | "origin-escape"
    | "browser-profile-cleanup-failed"
    | "visual-step-budget-invalid";

  constructor(code: PlaytestVisualBrowserDriverError["code"], message: string) {
    super(message);
    this.name = "PlaytestVisualBrowserDriverError";
    this.code = code;
  }
}

/**
 * The failure a failed open reports.
 *
 * An open that ran out of time is not a missing game: the browser did not
 * answer inside the approved budget. Every other failure is reported as the
 * source being unavailable, which is what the driver can honestly say about
 * a page it could not open.
 */
function openFailureCode(
  error: unknown
): PlaytestVisualBrowserDriverError["code"] {
  if (error instanceof PlaytestVisualBrowserDriverError) return error.code;
  // Playwright's own timeout is named; it is the only timeout the driver sees
  // from the browser side.
  if (error instanceof Error && error.name === "TimeoutError") {
    return "browser-open-timeout";
  }
  return "source-unavailable";
}

/**
 * Give a browser and its context back without waiting for them indefinitely.
 *
 * The failure path has to finish: an episode that cannot report its own
 * failure is worse than one that reports a failure late. Both closes share one
 * deadline, so a wedged browser costs the episode this much and no more.
 */
async function closeWithinDeadline(
  closeables: readonly ({ close(): Promise<unknown> } | null | undefined)[]
): Promise<void> {
  const pending = closeables.filter(
    (closeable): closeable is { close(): Promise<unknown> } => closeable != null
  );
  if (pending.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(
        pending.map((closeable) => closeable.close().catch(() => undefined))
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run one step of the open under the approved episode budget.
 *
 * The open touches a browser, a context and a page, and each of those steps
 * has its own timeout or none at all. Only the approved wall-time budget
 * covers the whole open, so every step runs under the same absolute deadline:
 * a browser that never answers costs the episode its budget and not one
 * millisecond more.
 */
async function withinOpenBudget<T>(
  operation: Promise<T>,
  deadlineAt: number,
  now: () => number
): Promise<T> {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) {
    throw new PlaytestVisualBrowserDriverError(
      "browser-open-timeout",
      "The approved episode budget was spent before the visual browser opened."
    );
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new PlaytestVisualBrowserDriverError(
              "browser-open-timeout",
              "The approved episode budget was spent before the visual browser opened."
            )
          );
        }, remainingMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function websocketOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A span of text, from its first character to the one after its last. */
interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** Whether the code is an ASCII digit. */
function isDigitCharacter(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** Whether the code separates the digits of a card-like chain. */
function isCardSeparator(code: number): boolean {
  return code === 0x20 || code === 0x2d;
}

/**
 * The card-like digit chains in a text.
 *
 * A chain is the run of digits a reader would read as one card number: the
 * digits themselves and the spaces and dashes between them. It holds at
 * least thirteen digits and at most nineteen, and the separator run after
 * its last digit belongs to whatever follows the chain rather than to the
 * chain itself.
 *
 * The scan walks the text once. A chain too short to be a card number ends
 * the walk over it instead of restarting it from every digit in it, so the
 * scan stays linear in the length of the text.
 */
function cardNumberSpans(text: string): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  let index = 0;
  while (index < text.length) {
    if (!isDigitCharacter(text.charCodeAt(index))) {
      index += 1;
      continue;
    }
    const start = index;
    let digits = 1;
    let cursor = index + 1;
    while (digits < CARD_NUMBER_MAX_DIGITS) {
      let next = cursor;
      while (next < text.length && isCardSeparator(text.charCodeAt(next))) {
        next += 1;
      }
      if (next >= text.length || !isDigitCharacter(text.charCodeAt(next))) {
        break;
      }
      digits += 1;
      cursor = next + 1;
    }
    if (digits >= CARD_NUMBER_MIN_DIGITS) spans.push({ start, end: cursor });
    index = cursor;
  }
  return spans;
}

/**
 * The text with its card-like digit chains redacted.
 *
 * The chain is replaced whole, so no part of a card number survives the
 * redaction.
 */
function redactCardNumbers(text: string): string {
  const spans = cardNumberSpans(text);
  if (spans.length === 0) return text;
  let redacted = "";
  let cursor = 0;
  for (const span of spans) {
    redacted += text.slice(cursor, span.start) + "[redacted]";
    cursor = span.end;
  }
  return redacted + text.slice(cursor);
}

/**
 * Whether the text on the screen holds something the Runtime must not record.
 *
 * The page says what is on the screen and the Runtime says what it may
 * record, and both have to read an address and a card number the same way.
 */
function containsSensitiveText(text: string): boolean {
  return SENSITIVE_EMAIL_PATTERN.test(text) || cardNumberSpans(text).length > 0;
}

function redactName(value: string): string {
  return withoutControlCharacters(
    redactCardNumbers(value.replaceAll(EMAIL_PATTERN, "[redacted]"))
  )
    .trim()
    .slice(0, 256);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Whether the page is showing the game yet.
 *
 * A game boots in stages, and the stage the driver used to capture is the
 * one where the document exists but nothing is on the screen: the canvas
 * element has not been created, or it is hidden, or it is still one flat
 * colour. A frame taken then shows a blank screen no matter what the player
 * is looking at, and the decision that follows is grounded in nothing.
 *
 * The page shows the game when the player can see it, and a page shows
 * itself in one of two ways:
 *
 * - a canvas that shows more than one colour is a painted scene. The canvas
 *   is sampled inside a frame callback, because a drawing buffer that is not
 *   preserved is emptied once the frame has been composited.
 * - a game that renders into the DOM has no canvas to read, and it shows
 *   itself as visible controls or visible text.
 *
 * This runs in the page, so it must not close over anything out here.
 */
function pageHasRenderedInBrowser(): Promise<boolean> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      // eslint-disable-next-line unicorn/consistent-function-scoping -- this function is serialized into the page, so it cannot use module scope
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        // An element that reaches past the viewport is still drawn; what
        // matters is that the page shows part of it.
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };
      for (const canvas of document.querySelectorAll("canvas")) {
        if (!visible(canvas)) continue;
        if (canvas.width === 0 || canvas.height === 0) continue;
        const probe = document.createElement("canvas");
        probe.width = 16;
        probe.height = 16;
        const context = probe.getContext("2d");
        if (context === null) continue;
        // Nearest-neighbour sampling: a smoothed downscale averages fine
        // detail away, and a scene of thin stripes would read as one flat
        // colour long after it has been painted.
        context.imageSmoothingEnabled = false;
        try {
          context.drawImage(canvas, 0, 0, 16, 16);
        } catch {
          continue;
        }
        const pixels = context.getImageData(0, 0, 16, 16).data;
        const first = [pixels[0], pixels[1], pixels[2], pixels[3]];
        for (let index = 4; index < pixels.length; index += 4) {
          if (
            pixels[index] !== first[0] ||
            pixels[index + 1] !== first[1] ||
            pixels[index + 2] !== first[2] ||
            pixels[index + 3] !== first[3]
          ) {
            resolve(true);
            return;
          }
        }
      }
      // A game that renders into the DOM shows itself as rendered text.
      // innerText counts only text the browser actually laid out: textContent
      // counts the text of hidden descendants too, and a booting page is full
      // of markup that is not on the screen.
      // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- textContent is the hidden text, which is exactly what this must not count
      if ((document.body?.innerText ?? "").trim().length > 0) {
        resolve(true);
        return;
      }
      // Or as a control the player can see.
      const controlSelector =
        'button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="textbox"],[role="combobox"]';
      for (const element of document.querySelectorAll(controlSelector)) {
        if (visible(element)) {
          resolve(true);
          return;
        }
      }
      resolve(false);
    });
  });
}

/**
 * The patterns the page read needs, handed to the page itself.
 *
 * The page read runs inside the browser, where the Runtime's module scope
 * does not exist, so the patterns it needs travel with it.
 */
interface PageReadPatterns {
  /** The whitespace the words of an attribute are separated by. */
  readonly whitespace: RegExp;
  /** The autocomplete values that mark a field as a password field. */
  readonly passwordAutocomplete: RegExp;
}

const PAGE_READ_PATTERNS: PageReadPatterns = {
  whitespace: WHITESPACE_PATTERN,
  passwordAutocomplete: PASSWORD_AUTOCOMPLETE_PATTERN
};

function pageReadInBrowser(patterns: PageReadPatterns): RawPageReport {
  const selector =
    'button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="textbox"],[role="combobox"]';
  const allowedRoles = new Set([
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
  ]);
  // The page cannot change while this read runs, so the viewport is the
  // one the read started with.
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= 0 &&
      rect.top >= 0 &&
      rect.right <= viewport.width &&
      rect.bottom <= viewport.height &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  };
  const accessibleName = (element: Element): string => {
    const aria = element.getAttribute("aria-label");
    if (aria?.trim()) return aria.trim().slice(0, 512);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(patterns.whitespace)
        .map((id) => {
          const label =
            id === "" ? null : document.querySelector(`#${CSS.escape(id)}`);
          return label?.textContent ?? "";
        })
        .join(" ")
        .trim();
      if (text) return text.slice(0, 512);
    }
    if ("labels" in element) {
      const labels = Array.from((element as HTMLInputElement).labels ?? [])
        .map((label) => label.textContent ?? "")
        .join(" ")
        .trim();
      if (labels) return labels.slice(0, 512);
    }
    const title = element.getAttribute("title");
    if (title?.trim()) return title.trim().slice(0, 512);
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return "";
    return (element.textContent ?? "").trim().slice(0, 512);
  };
  /**
   * The role an element claims, or the one its tag implies.
   *
   * The role the element states wins over the one its tag implies, and an
   * element that claims nothing and implies nothing has no role.
   */
  const claimedRole = (element: Element): string | null => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.split(patterns.whitespace)[0] ?? null;
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type !== "hidden") return "textbox";
    }
    return null;
  };
  /**
   * The role the Runtime offers for an element, or null when it offers none.
   *
   * A role the Runtime does not act on is no role at all: the observation
   * only carries the roles the Runtime can dispatch to.
   */
  const roleFor = (element: Element): string | null => {
    const role = claimedRole(element);
    return role !== null && allowedRoles.has(role) ? role : null;
  };
  const inputKindFor = (element: Element): RawControl["inputKind"] => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    const autocomplete = element.getAttribute("autocomplete") ?? "";
    if (
      (tag === "input" && type === "password") ||
      patterns.passwordAutocomplete.test(autocomplete)
    ) {
      return "password";
    }
    if (
      tag === "textarea" ||
      (tag === "input" &&
        !["button", "submit", "reset", "checkbox", "radio", "hidden"].includes(
          type
        )) ||
      element.getAttribute("contenteditable") === "true"
    ) {
      return "text-entry";
    }
    return "none";
  };
  const candidates = Array.from(document.querySelectorAll(selector));
  const controls: RawControl[] = [];
  let passwordVisible = false;
  let visibleControlCount = 0;
  for (const [index, element] of candidates.entries()) {
    if (!visible(element)) continue;
    visibleControlCount += 1;
    if (controls.length >= 257) continue;
    const role = roleFor(element);
    if (!role) continue;
    const inputKind = inputKindFor(element);
    if (inputKind === "password") passwordVisible = true;
    const rect = element.getBoundingClientRect();
    const disabled =
      ("disabled" in element &&
        Boolean((element as HTMLButtonElement).disabled)) ||
      element.getAttribute("aria-disabled") === "true";
    controls.push({
      index,
      role: role as RawControl["role"],
      name: accessibleName(element),
      enabled: !disabled,
      focused: document.activeElement === element,
      inputKind,
      navigationOrigin:
        role === "link"
          ? (() => {
              try {
                const destination = new URL(
                  (element as HTMLAnchorElement).href,
                  document.baseURI
                );
                return destination.protocol === "http:" ||
                  destination.protocol === "https:"
                  ? destination.origin
                  : null;
              } catch {
                return null;
              }
            })()
          : null,
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      }
    });
  }
  return {
    controls: controls.slice(0, 256),
    passwordVisible,
    truncatedControls: visibleControlCount > 256
  };
}

/**
 * What makes a control the same control.
 *
 * The identity is the control's own content, never its position: a game that
 * re-renders its layout moves a button without changing what the button is,
 * and an action promised against that button must still be dispatched to it.
 * The ordinal distinguishes controls that share a content, so two identical
 * buttons keep separate identities.
 */
function controlIdentity(control: RawControl): string {
  return JSON.stringify([
    control.role,
    redactName(control.name),
    control.inputKind
  ]);
}

function controlId(identity: string, ordinal: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([identity, ordinal]))
    .digest("hex")
    .slice(0, 16);
  return `c-${digest}`;
}

function validViewport(viewport: PlaytestVisualViewport): boolean {
  return (
    Number.isSafeInteger(viewport.width) &&
    viewport.width >= 320 &&
    viewport.width <= 4096 &&
    Number.isSafeInteger(viewport.height) &&
    viewport.height >= 240 &&
    viewport.height <= 4096 &&
    viewport.width * viewport.height <= 4_194_304 &&
    Number.isFinite(viewport.deviceScaleFactor) &&
    viewport.deviceScaleFactor >= 0.5 &&
    viewport.deviceScaleFactor <= 4
  );
}

function inputKindForCurrentFocus(
  value: unknown
): "none" | "text-entry" | "password" {
  if (value === "password" || value === "text-entry") return value;
  return "none";
}

function keyForBrowser(key: string): string {
  switch (key) {
    case "KeyW": {
      return "w";
    }
    case "KeyA": {
      return "a";
    }
    case "KeyS": {
      return "s";
    }
    case "KeyD": {
      return "d";
    }
    default: {
      return key;
    }
  }
}

/** Chromium must not inherit Runtime/router/service credentials or user HOME. */
function browserProcessEnvironment(profileRoot: string): NodeJS.ProcessEnv {
  const systemPath =
    process.platform === "win32"
      ? String.raw`C:\Windows\System32;C:\Windows`
      : "/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    PATH: systemPath,
    HOME: path.join(profileRoot, "home"),
    TMPDIR: path.join(profileRoot, "tmp"),
    TEMP: path.join(profileRoot, "tmp"),
    TMP: path.join(profileRoot, "tmp"),
    LANG: "en_US.UTF-8",
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {})
  };
}

export class PlaytestVisualBrowserDriver implements PlaytestVisualEpisodeDriver {
  private readonly target: WorkspaceVisualPlaytestTargetApproval;
  private readonly episodeId: string;
  private readonly artifacts: PlaytestArtifactStore;
  private readonly viewport: PlaytestVisualViewport;
  private readonly actionTimeoutMs: number;
  private readonly maxSteps: number;
  private readonly renderWaitMs: number;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly browserProfileRoot: string;
  private readonly startedAt: number;
  private readonly events: PlaytestVisualBrowserEvent[] = [];
  private lastObservation: PlaytestVisualObservation | null = null;
  private controlIndexes = new Map<
    string,
    { readonly identity: string; readonly ordinal: number }
  >();
  private controlNavigationOrigins = new Map<string, string | null>();
  private inputAttempts = 0;
  private inputValidated = 0;
  private inputDispatched = 0;
  private inputRejected = 0;
  private captureCount = 0;
  private capturedBytes = 0;
  private blockedRequestCount = 0;
  private observationCalls = 0;
  private actionCalls = 0;
  private closed = false;
  private originEscape = false;
  private entryLoaded = false;
  private captureIncomplete = false;
  /** Whether the driver has already waited for the page to show the game. */
  private rendered = false;
  private terminalBlock: PlaytestVisualObservationBlockReason | null = null;
  private closeResult: {
    readonly events:
      ReturnType<PlaytestArtifactStore["writeWindow"]>["reference"] | null;
    readonly eventMissingReason: "event-window-unavailable" | null;
    readonly browserProfileCleanup: "removed" | "failed";
  } | null = null;

  private constructor(input: {
    readonly options: PlaytestVisualBrowserDriverOptions;
    readonly browser: Browser;
    readonly context: BrowserContext;
    readonly page: Page;
    readonly browserProfileRoot: string;
    readonly blockedRequestsBeforeReady: number;
  }) {
    this.target = input.options.target;
    this.episodeId = input.options.episodeId;
    this.artifacts = input.options.artifacts;
    this.viewport = input.options.viewport;
    this.actionTimeoutMs = input.options.actionTimeoutMs;
    this.maxSteps = input.options.maxSteps;
    this.renderWaitMs = input.options.renderWaitMs ?? DEFAULT_RENDER_WAIT_MS;
    this.now = input.options.now ?? Date.now;
    this.id = input.options.id ?? randomUUID;
    this.browser = input.browser;
    this.context = input.context;
    this.page = input.page;
    this.browserProfileRoot = input.browserProfileRoot;
    this.startedAt = this.now();
    this.blockedRequestCount = input.blockedRequestsBeforeReady;
    this.recordEvent({ type: "browser-started" });
  }

  static async open(
    options: PlaytestVisualBrowserDriverOptions
  ): Promise<PlaytestVisualBrowserDriver> {
    assertWorkspaceVisualPlaytestTargetApproval(options.target);
    if (
      options.target.revokedAt !== null ||
      options.target.entryRequirements !== "none" ||
      options.target.controlTimingClass === "continuous"
    ) {
      throw new PlaytestVisualBrowserDriverError(
        "target-not-runnable",
        "The approved target is revoked, gated, or requires continuous control."
      );
    }
    if (
      options.artifacts.boundWorkspaceId() !== options.target.workspaceId ||
      !options.episodeId.trim()
    ) {
      throw new TypeError(
        "Visual driver workspace or episode identity mismatches."
      );
    }
    if (!validViewport(options.viewport)) {
      throw new TypeError(
        "Visual driver viewport is outside its resource bound."
      );
    }
    if (
      !Number.isSafeInteger(options.actionTimeoutMs) ||
      options.actionTimeoutMs < 1 ||
      options.actionTimeoutMs > options.target.limits.wallTimeMs ||
      !Number.isSafeInteger(options.maxSteps) ||
      options.maxSteps < 1 ||
      options.maxSteps > options.target.limits.maxStepsPerEpisode
    ) {
      throw new PlaytestVisualBrowserDriverError(
        "visual-step-budget-invalid",
        "Visual browser action limits are invalid."
      );
    }
    if (
      !options.target.inputCapabilities.some((capability) =>
        SUPPORTED_INPUTS.includes(
          capability as (typeof SUPPORTED_INPUTS)[number]
        )
      )
    ) {
      throw new PlaytestVisualBrowserDriverError(
        "driver-unavailable",
        "Runtime has no installed driver for the target's approved inputs."
      );
    }
    const browserType = options.browserType ?? chromium;
    const executable = resolveChromiumExecutablePath(browserType);
    if (!executable) {
      throw new PlaytestVisualBrowserDriverError(
        "driver-unavailable",
        "The isolated Chromium executable is not installed."
      );
    }

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let driver: PlaytestVisualBrowserDriver | null = null;
    let browserProfileRoot: string | null = null;
    let earlyBlockedRequests = 0;
    // The approved episode budget bounds the open as well as the steps that
    // follow it. The browser, the context and the page each have their own
    // timeout or none at all; only the budget covers the whole open, so the
    // open runs under it.
    const now = options.now ?? Date.now;
    const openDeadlineAt = now() + options.target.limits.wallTimeMs;
    const openTimeoutMs = (): number => Math.max(1, openDeadlineAt - now());
    try {
      browserProfileRoot = mkdtempSync(
        path.join(tmpdir(), "autodev-visual-browser-")
      );
      chmodSync(browserProfileRoot, 0o700);
      mkdirSync(path.join(browserProfileRoot, "home"), {
        recursive: true,
        mode: 0o700
      });
      mkdirSync(path.join(browserProfileRoot, "tmp"), {
        recursive: true,
        mode: 0o700
      });
      browser = await withinOpenBudget(
        browserType.launch({
          executablePath: executable,
          headless: true,
          env: browserProcessEnvironment(browserProfileRoot),
          timeout: openTimeoutMs()
        }),
        openDeadlineAt,
        now
      );
      context = await withinOpenBudget(
        browser.newContext({
          viewport: {
            width: options.viewport.width,
            height: options.viewport.height
          },
          deviceScaleFactor: options.viewport.deviceScaleFactor,
          acceptDownloads: false,
          serviceWorkers: "block",
          permissions: []
        }),
        openDeadlineAt,
        now
      );
      let page: Page | null = null;
      await context.route("**/*", async (route) => {
        const request = route.request();
        const origin = safeOrigin(request.url());
        if (origin && options.target.allowedOrigins.includes(origin)) {
          await route.continue();
          return;
        }
        if (driver) driver.noteBlockedRequest();
        else earlyBlockedRequests += 1;
        const mainFrameNavigation =
          request.isNavigationRequest() &&
          page !== null &&
          request.frame() === page.mainFrame();
        if (mainFrameNavigation) driver?.noteOriginEscape();
        await route.abort("blockedbyclient");
        if (mainFrameNavigation) driver?.closeForOriginEscape();
      });
      await context.routeWebSocket("**/*", (socket) => {
        const origin = websocketOrigin(socket.url());
        if (origin && options.target.allowedOrigins.includes(origin)) {
          socket.connectToServer();
          return;
        }
        if (driver) driver.noteBlockedRequest();
        else earlyBlockedRequests += 1;
        void socket.close({
          code: 1008,
          reason: "Target origin is not approved."
        });
      });
      const mainPage = await withinOpenBudget(
        context.newPage(),
        openDeadlineAt,
        now
      );
      page = mainPage;
      mainPage.setDefaultTimeout(options.actionTimeoutMs);
      mainPage.setDefaultNavigationTimeout(options.actionTimeoutMs);
      driver = new PlaytestVisualBrowserDriver({
        options,
        browser,
        context,
        page: mainPage,
        browserProfileRoot,
        blockedRequestsBeforeReady: earlyBlockedRequests
      });
      context.on("page", (popup) => {
        if (popup === mainPage) return;
        driver?.recordEvent({ type: "popup-blocked" });
        void popup.close().catch(() => undefined);
      });
      mainPage.on("framenavigated", (frame) => {
        if (!driver?.entryLoaded) return;
        if (frame !== mainPage.mainFrame()) return;
        const origin = safeOrigin(frame.url());
        if (!origin || !options.target.allowedOrigins.includes(origin)) {
          driver?.blockForOriginEscape();
          return;
        }
        // A new page has to show the game again before it is observed.
        if (driver) driver.rendered = false;
      });
      await withinOpenBudget(
        mainPage.goto(options.target.entryUrl, {
          // The document is what navigation owes the driver. Whether the game
          // has painted is the observation's business, and the driver answers
          // that from the page itself (see waitForRenderedGame). Waiting for
          // the load event instead would make the open depend on every
          // subresource of a game that is still being built: one pending
          // request is enough to fail an open that was never in trouble.
          waitUntil: "domcontentloaded",
          timeout: openTimeoutMs()
        }),
        openDeadlineAt,
        now
      );
      // The document is ready; whether the game has painted is not the
      // navigation's business but the observation's, and the driver answers
      // that from the page itself (see waitForRenderedGame). Settling the
      // network here instead would only delay the first observation by a
      // fixed amount, which is both an arbitrary number and a delay that
      // lets the game move on before the frame the player is looking at is
      // taken.
      const origin = safeOrigin(mainPage.url());
      if (!origin || !options.target.allowedOrigins.includes(origin)) {
        driver.blockForOriginEscape();
        throw new PlaytestVisualBrowserDriverError(
          ORIGIN_ESCAPE,
          "The game navigated outside its approved origin."
        );
      }
      driver.entryLoaded = true;
      return driver;
    } catch (error) {
      // The browser has to be given back, and the episode has to be able to
      // report its own failure: a browser that cannot be closed is bounded
      // here rather than allowed to hold the episode open.
      await closeWithinDeadline([context, browser]);
      if (browserProfileRoot !== null) {
        try {
          rmSync(browserProfileRoot, { recursive: true, force: true });
        } catch {
          throw new PlaytestVisualBrowserDriverError(
            "browser-profile-cleanup-failed",
            "Runtime could not remove the transient browser profile."
          );
        }
      }
      if (error instanceof PlaytestVisualBrowserDriverError) throw error;
      if (driver?.originEscape) {
        throw new PlaytestVisualBrowserDriverError(
          ORIGIN_ESCAPE,
          "The game redirected outside its approved origin."
        );
      }
      throw new PlaytestVisualBrowserDriverError(
        openFailureCode(error),
        "Runtime could not open the approved visual game target."
      );
    }
  }

  private elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  /**
   * Milliseconds left in the approved per-episode wall-time budget.
   *
   * The driver owns that budget — it enforces the same ceiling before every
   * observation and before every action — so a caller that must not outlive the
   * episode reads the remainder here instead of starting a second, divergent
   * clock against the same limit.
   */
  remainingWallTimeMs(): number {
    return Math.max(0, this.target.limits.wallTimeMs - this.elapsedMs());
  }

  private noteBlockedRequest(): void {
    this.blockedRequestCount += 1;
  }

  private blockForOriginEscape(): void {
    this.noteOriginEscape();
    this.closeForOriginEscape();
  }

  private noteOriginEscape(): void {
    if (this.originEscape) return;
    this.originEscape = true;
    this.terminalBlock = ORIGIN_ESCAPE;
    this.recordEvent({
      type: "cross-origin-blocked",
      refusalReason: ORIGIN_ESCAPE
    });
  }

  private closeForOriginEscape(): void {
    void this.context.close().catch(() => undefined);
  }

  private currentOrigin(): string | null {
    return safeOrigin(this.page.url());
  }

  private blockObservation(
    reason: PlaytestVisualObservationBlockReason
  ): PlaytestVisualObservationResult {
    this.captureIncomplete = true;
    this.terminalBlock = reason;
    return { status: "blocked", reason };
  }

  /**
   * The page as the driver reads it: what the page reports about itself,
   * and the driver's own verdict on the text the player can see.
   *
   * The rendered text is read through the browser's own text of the body
   * rather than through the page's markup: the markup also holds the text
   * the player cannot see, and a hidden address is not a thing on the
   * screen. A page without a body shows nothing, which is not a reason to
   * fail the read.
   */
  private async readPage(): Promise<RawPageRead> {
    const [report, visibleText] = await Promise.all([
      this.page.evaluate(pageReadInBrowser, PAGE_READ_PATTERNS),
      this.page
        .locator("body")
        // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- Playwright reads the text the browser laid out, and textContent would count the text the player cannot see
        .innerText()
        .catch(() => "")
    ]);
    return {
      ...report,
      sensitiveTextVisible: containsSensitiveText(visibleText)
    };
  }

  /**
   * Wait for the page to show the game before a frame is captured.
   *
   * A game boots in stages, and the driver used to capture the stage where
   * the document exists but nothing is on the screen yet: the observation
   * would report a blank screen no matter what the player sees, and the
   * decision that follows is grounded in nothing.
   *
   * The wait is bounded and it happens once per page. A game that never
   * shows itself is captured as it is rather than failing the episode, and
   * every later observation reports the screen as it is: from then on the
   * browser has shown the player a scene, so a blank frame is a real thing
   * on the screen rather than a game that has not started.
   */
  private async waitForRenderedGame(): Promise<void> {
    if (this.rendered) return;
    try {
      const deadline = this.now() + this.renderWaitMs;
      for (;;) {
        let rendered = true;
        try {
          // eslint-disable-next-line no-await-in-loop -- the page is polled until it shows the game
          rendered = await this.page.evaluate(pageHasRenderedInBrowser);
        } catch {
          break;
        }
        if (rendered || this.now() >= deadline) break;
        // eslint-disable-next-line no-await-in-loop -- the page is polled until it shows the game
        await this.page
          .waitForTimeout(RENDER_WAIT_POLL_MS)
          .catch(() => undefined);
      }
    } finally {
      this.rendered = true;
    }
  }

  private async capturePng(): Promise<Uint8Array> {
    const bytes = await this.page.screenshot({
      type: "png",
      mask: [this.page.locator(MASK_SELECTOR)],
      maskColor: "#000000",
      timeout: this.actionTimeoutMs
    });
    return new Uint8Array(bytes);
  }

  async observe(): Promise<PlaytestVisualObservationResult> {
    this.observationCalls += 1;
    if (this.terminalBlock) {
      return { status: "blocked", reason: this.terminalBlock };
    }
    if (this.originEscape || this.closed) {
      return this.blockObservation(ORIGIN_ESCAPE);
    }
    if (this.elapsedMs() >= this.target.limits.wallTimeMs) {
      return this.blockObservation(WALL_TIME_LIMIT);
    }
    if (this.events.length >= PLAYESTS_ARTIFACT_MAX_WINDOW_STEPS - 1) {
      return this.blockObservation(EVENT_BUDGET_EXHAUSTED);
    }
    if (this.captureCount >= this.target.limits.screenshotCountPerEpisode) {
      return this.blockObservation("capture-budget-exhausted");
    }
    const origin = this.currentOrigin();
    if (!origin || !this.target.allowedOrigins.includes(origin)) {
      this.blockForOriginEscape();
      return this.blockObservation(ORIGIN_ESCAPE);
    }
    let pageRead: RawPageRead;
    let png: Uint8Array;
    try {
      await this.waitForRenderedGame();
      pageRead = await this.readPage();
      if (pageRead.passwordVisible) {
        return this.blockObservation("auth-or-setup-required");
      }
      if (pageRead.sensitiveTextVisible) {
        return this.blockObservation(SENSITIVE_VISUAL_UNREDACTABLE);
      }
      png = await this.capturePng();
    } catch {
      return this.blockObservation(SENSITIVE_VISUAL_UNREDACTABLE);
    }
    if (
      png.byteLength > PLAYTESTS_ARTIFACT_MAX_BYTES ||
      this.capturedBytes + png.byteLength >
        this.target.limits.artifactBytesPerEpisode
    ) {
      return this.blockObservation("capture-budget-exhausted");
    }
    let frame: PlaytestVisualObservation["frame"];
    try {
      frame = this.artifacts.writeArtifact({
        mediaType: "image/png",
        bytes: png
      }).reference;
    } catch {
      return this.blockObservation("capture-budget-exhausted");
    }
    this.captureCount += 1;
    this.capturedBytes += png.byteLength;
    const observationId = this.id();
    this.controlIndexes.clear();
    this.controlNavigationOrigins.clear();
    const ordinals = new Map<string, number>();
    const controls: PlaytestVisualControl[] = pageRead.controls.map(
      (control) => {
        const identity = controlIdentity(control);
        const ordinal = ordinals.get(identity) ?? 0;
        ordinals.set(identity, ordinal + 1);
        const id = controlId(identity, ordinal);
        this.controlIndexes.set(id, { identity, ordinal });
        this.controlNavigationOrigins.set(id, control.navigationOrigin);
        return {
          controlId: id,
          role: control.role,
          name:
            redactName(control.name) ||
            (control.inputKind === "none"
              ? `${control.role} control`
              : "Text entry field"),
          enabled: control.enabled,
          focused: control.focused,
          inputKind: control.inputKind,
          bounds: control.bounds
        };
      }
    );
    const visibleWarnings = [
      ...(pageRead.truncatedControls
        ? ["The visible control list was truncated at its evidence bound."]
        : []),
      ...(this.blockedRequestCount > 0
        ? ["Some outbound requests were blocked by the approved-origin policy."]
        : [])
    ];
    const observation: PlaytestVisualObservation = {
      schema: PLAYTEST_VISUAL_OBSERVATION_SCHEMA,
      observationId,
      workspaceId: this.target.workspaceId,
      targetId: this.target.targetId,
      episodeId: this.episodeId,
      origin,
      capturedAt: new Date(this.now()).toISOString(),
      viewport: this.viewport,
      frame,
      privacyState: pageRead.controls.some(
        (control) => control.inputKind !== "none"
      )
        ? "redacted"
        : "clear",
      controls,
      visibleWarnings,
      phaseEvidence: null,
      progressEvidence: null
    };
    try {
      assertPlaytestVisualObservation(observation, this.target);
    } catch {
      this.artifacts.remove(frame);
      this.captureCount -= 1;
      this.capturedBytes -= png.byteLength;
      return this.blockObservation(SENSITIVE_VISUAL_UNREDACTABLE);
    }
    this.lastObservation = observation;
    this.recordEvent({
      type: "frame-captured",
      step: this.inputDispatched,
      observationId,
      frameArtifactId: frame.artifactId
    });
    return { status: "observed", observation };
  }

  async act(
    action: PlaytestVisualAction
  ): Promise<PlaytestVisualActionReceipt> {
    this.actionCalls += 1;
    if (this.terminalBlock) {
      return this.refuseAction(
        action,
        this.inputAttempts,
        this.actionRefusalForBlock()
      );
    }
    this.inputAttempts += 1;
    const step = this.inputAttempts - 1;
    if (this.events.length >= PLAYESTS_ARTIFACT_MAX_WINDOW_STEPS - 1) {
      this.terminalBlock = EVENT_BUDGET_EXHAUSTED;
      this.captureIncomplete = true;
      return this.refuseAction(action, step, EVENT_BUDGET_EXHAUSTED);
    }
    if (this.inputAttempts > this.maxSteps) {
      return this.refuseAction(action, step, "action-budget-exhausted");
    }
    if (this.elapsedMs() >= this.target.limits.wallTimeMs) {
      return this.refuseAction(action, step, WALL_TIME_LIMIT);
    }
    if (this.closed || this.originEscape || this.lastObservation === null) {
      return this.refuseAction(action, step, "driver-state-unavailable");
    }
    const origin = this.currentOrigin();
    if (!origin) {
      return this.refuseAction(action, step, ORIGIN_NOT_APPROVED);
    }
    const admission = admitPlaytestVisualAction({
      target: this.target,
      observation: this.lastObservation,
      action,
      runtimeSupportedInputs: SUPPORTED_INPUTS,
      currentOrigin: origin,
      currentViewport: this.viewport,
      nowMs: this.now(),
      // An observation is trusted for as long as the episode may run. The
      // approved wall-time budget is the only clock the episode has, and a
      // model that needs most of it to answer is still answering inside the
      // budget the operator approved. What the action must match is the
      // latest observation, and that is checked by observation id; what it
      // must still find on the screen is re-read from the page before the
      // input is dispatched.
      maxObservationAgeMs: this.target.limits.wallTimeMs
    });
    if (!admission.admitted) {
      return this.refuseAction(action, step, admission.reason);
    }
    this.inputValidated += 1;
    const startedAt = this.now();
    let latest: RawPageRead;
    try {
      latest = await this.readPage();
    } catch {
      this.terminalBlock = SENSITIVE_VISUAL_UNREDACTABLE;
      this.captureIncomplete = true;
      return this.refuseAction(action, step, SENSITIVE_VISUAL_UNREDACTABLE);
    }
    if (latest.passwordVisible) {
      this.terminalBlock = "auth-or-setup-required";
      this.captureIncomplete = true;
      return this.refuseAction(action, step, "auth-or-setup-required");
    }
    if (latest.sensitiveTextVisible) {
      this.terminalBlock = SENSITIVE_VISUAL_UNREDACTABLE;
      this.captureIncomplete = true;
      return this.refuseAction(action, step, SENSITIVE_VISUAL_UNREDACTABLE);
    }
    const refusal = await this.dispatchInput(
      action,
      step,
      latest,
      this.lastObservation
    );
    if (refusal !== null) {
      return refusal;
    }
    this.inputDispatched += 1;
    const receipt: PlaytestVisualActionReceipt = {
      status: "dispatched",
      step,
      observationId: action.observationId,
      actionKind: action.kind,
      dispatchedAt: new Date(this.now()).toISOString(),
      driverDurationMs: Math.max(0, this.now() - startedAt),
      gameAcknowledgement: "not-observed"
    };
    this.recordEvent({
      type: "input-dispatched",
      step,
      observationId: action.observationId,
      frameArtifactId: this.lastObservation.frame.artifactId,
      actionKind: action.kind
    });
    return receipt;
  }

  /**
   * Dispatch the input the action names, against the page as it is now.
   *
   * The observation promised a control; the page is read again before the
   * input is dispatched, so the control may have moved, changed or become
   * sensitive since. The refusal is returned when the page no longer offers
   * what the observation promised, and null when the input was dispatched.
   */
  private async dispatchInput(
    action: PlaytestVisualAction,
    step: number,
    latest: RawPageRead,
    observation: PlaytestVisualObservation
  ): Promise<PlaytestVisualActionReceipt | null> {
    try {
      switch (action.kind) {
        case "activate-control": {
          const promised = this.controlIndexes.get(action.controlId);
          if (promised === undefined) {
            return this.refuseAction(action, step, "control-changed");
          }
          // The page is read again before the input is dispatched, so the
          // control the observation promised may have moved. It is the same
          // control when the page still offers a control with that identity,
          // wherever it now sits; only a control that is gone, or no longer
          // offers what the observation promised, is a refusal.
          const matches = latest.controls.filter(
            (control) => controlIdentity(control) === promised.identity
          );
          const current = matches[promised.ordinal];
          if (!current || !current.enabled || current.inputKind !== "none") {
            return this.refuseAction(action, step, "control-changed");
          }
          const capturedDestination = this.controlNavigationOrigins.get(
            action.controlId
          );
          if (
            current.role === "link" &&
            (current.navigationOrigin !== capturedDestination ||
              !current.navigationOrigin ||
              !this.target.allowedOrigins.includes(current.navigationOrigin))
          ) {
            this.blockForOriginEscape();
            return this.refuseAction(action, step, ORIGIN_NOT_APPROVED);
          }
          await this.page
            .locator(CONTROL_SELECTOR)
            .nth(current.index)
            .click({ timeout: this.actionTimeoutMs });
          break;
        }
        case "pointer-click": {
          const currentFrame = await this.capturePng();
          if (sha256(currentFrame) !== observation.frame.sha256) {
            return this.refuseAction(action, step, "stale-observation");
          }
          await this.page.mouse.click(action.x, action.y);
          break;
        }
        case "key-press": {
          const focused = latest.controls.find((control) => control.focused);
          if (inputKindForCurrentFocus(focused?.inputKind) !== "none") {
            return this.refuseAction(action, step, "text-entry-not-supported");
          }
          await this.page.keyboard.press(keyForBrowser(action.key));
          break;
        }
        case "gamepad-press": {
          return this.refuseAction(action, step, "input-unsupported");
        }
      }
    } catch {
      return this.refuseAction(
        action,
        step,
        this.originEscape ? ORIGIN_NOT_APPROVED : "control-changed"
      );
    }
    return null;
  }

  private refuseAction(
    action: PlaytestVisualAction,
    step: number,
    reason: ActionRefusalReason
  ): PlaytestVisualActionReceipt {
    this.inputRejected += 1;
    this.recordEvent({
      type: "input-refused",
      step,
      observationId: action.observationId,
      actionKind: action.kind,
      refusalReason: reason
    });
    return { status: "refused", step, reason } as PlaytestVisualActionReceipt;
  }

  private actionRefusalForBlock(): ActionRefusalReason {
    switch (this.terminalBlock) {
      case ORIGIN_ESCAPE: {
        return ORIGIN_NOT_APPROVED;
      }
      case WALL_TIME_LIMIT: {
        return WALL_TIME_LIMIT;
      }
      case EVENT_BUDGET_EXHAUSTED: {
        return EVENT_BUDGET_EXHAUSTED;
      }
      default: {
        return "driver-state-unavailable";
      }
    }
  }

  telemetry(): PlaytestVisualBrowserTelemetry {
    return {
      schema: "autodev-playtest-visual-telemetry-v1",
      version: 1,
      inputAttempts: this.inputAttempts,
      inputValidated: this.inputValidated,
      inputDispatched: this.inputDispatched,
      inputAcknowledged: 0,
      inputRejected: this.inputRejected,
      driverToolCalls: {
        observe: this.observationCalls,
        act: this.actionCalls
      },
      captureCount: this.captureCount,
      capturedBytes: this.capturedBytes,
      blockedRequestCount: this.blockedRequestCount,
      coverage:
        this.originEscape || this.captureIncomplete ? "partial" : "complete"
    };
  }

  eventsSnapshot(): readonly PlaytestVisualBrowserEvent[] {
    return [...this.events];
  }

  async close(): Promise<{
    readonly events:
      ReturnType<PlaytestArtifactStore["writeWindow"]>["reference"] | null;
    readonly eventMissingReason: "event-window-unavailable" | null;
    readonly browserProfileCleanup: "removed" | "failed";
  }> {
    if (this.closeResult) return this.closeResult;
    this.closed = true;
    this.recordEvent({ type: "browser-closed" });
    let events:
      ReturnType<PlaytestArtifactStore["writeWindow"]>["reference"] | null =
      null;
    let eventMissingReason: "event-window-unavailable" | null = null;
    let browserProfileCleanup: "removed" | "failed" = "removed";
    try {
      const encodedBytes = new TextEncoder().encode(
        this.events.map((event) => JSON.stringify(event)).join("\n") + "\n"
      ).byteLength;
      if (
        this.events.length > PLAYESTS_ARTIFACT_MAX_WINDOW_STEPS ||
        this.capturedBytes + encodedBytes >
          this.target.limits.artifactBytesPerEpisode
      ) {
        eventMissingReason = "event-window-unavailable";
      } else {
        events = this.artifacts.writeWindow({
          mediaType: "application/x-ndjson",
          entries: this.events
        }).reference;
      }
    } catch {
      eventMissingReason = "event-window-unavailable";
    }
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
    try {
      rmSync(this.browserProfileRoot, { recursive: true, force: true });
    } catch {
      browserProfileCleanup = "failed";
    }
    this.closeResult = { events, eventMissingReason, browserProfileCleanup };
    return this.closeResult;
  }

  private recordEvent(input: {
    readonly type: PlaytestVisualBrowserEvent["type"];
    readonly step?: number;
    readonly observationId?: string;
    readonly frameArtifactId?: string;
    readonly actionKind?: PlaytestVisualAction["kind"];
    readonly refusalReason?: string;
  }): void {
    if (this.events.length >= PLAYESTS_ARTIFACT_MAX_WINDOW_STEPS) return;
    this.events.push({
      schema: VISUAL_EVENT_SCHEMA,
      eventId: this.id(),
      sequence: this.events.length,
      episodeId: this.episodeId,
      type: input.type,
      occurredAt: new Date(this.now()).toISOString(),
      step: input.step ?? null,
      observationId: input.observationId ?? null,
      frameArtifactId: input.frameArtifactId ?? null,
      actionKind: input.actionKind ?? null,
      refusalReason: input.refusalReason ?? null,
      blockedRequestCount: this.blockedRequestCount
    });
  }
}
