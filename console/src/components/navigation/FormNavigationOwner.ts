"use client";

import { usePathname, useRouter } from "next/navigation.js";
import React from "react";

import {
  ACCENT_TONE_CLASS,
  ERROR_TONE_CLASS,
  NEUTRAL_TONE_CLASS,
  SUCCESS_TONE_CLASS
} from "../ui/tones.ts";
import {
  registerLiveCountRefresh,
  shouldRefreshLiveCounts
} from "./live-count-refresh.ts";
import { navigateToWholePage } from "./whole-page-navigation.ts";

export type FormNavigationStatus =
  "idle" | "submitting" | "completed" | "error";

export interface FormNavigationRouter {
  /**
  Ask for the destination's whole page.
  
  Asking with no kind is asking for the full page: Next.js's prefetch
  answers with the full page unless it is told otherwise, and a partial
  answer is the route's loading state rather than the page.
  */
  readonly prefetch: (href: string) => void;
  readonly push: (
    href: string,
    options?: { readonly scroll?: boolean }
  ) => void;
  readonly replace: (
    href: string,
    options?: { readonly scroll?: boolean }
  ) => void;
  readonly refresh: () => void;
}

export interface FormElementLike {
  readonly disabled?: boolean | undefined;
  readonly name?: string | undefined;
  readonly value?: string | undefined;
  readonly type?: string | undefined;
  readonly tagName?: string | undefined;
  readonly checked?: boolean | undefined;
  readonly formAction?: string | undefined;
  readonly formMethod?: string | undefined;
  readonly formEnctype?: string | undefined;
  readonly formTarget?: string | undefined;
  readonly formNoValidate?: boolean | undefined;
  readonly getAttribute?: ((name: string) => string | null) | undefined;
  readonly hasAttribute?: ((name: string) => boolean) | undefined;
  readonly options?:
    | Iterable<{
        readonly value: string;
        readonly selected: boolean;
        readonly disabled?: boolean | undefined;
      }>
    | undefined;
}

export interface FormLike {
  readonly elements?: Iterable<FormElementLike> | undefined;
  readonly method?: string | undefined;
  readonly action?: string | undefined;
  readonly target?: string | undefined;
  readonly enctype?: string | undefined;
  readonly noValidate?: boolean | undefined;
  readonly checkValidity?: (() => boolean) | undefined;
  readonly reportValidity?: (() => boolean) | undefined;
  readonly getAttribute?: ((name: string) => string | null) | undefined;
  readonly hasAttribute?: ((name: string) => boolean) | undefined;
  readonly setAttribute?: ((name: string, value: string) => void) | undefined;
  readonly removeAttribute?: ((name: string) => void) | undefined;
  readonly querySelector?: ((selector: string) => Element | null) | undefined;
  readonly querySelectorAll?:
    ((selector: string) => Iterable<Element>) | undefined;
  readonly dataset?:
    DOMStringMap | Record<string, string | undefined> | undefined;
}

export interface FormSubmissionEvent {
  readonly defaultPrevented?: boolean | undefined;
  readonly preventDefault: () => void;
  readonly target: unknown;
  readonly submitter?: unknown;
}

export interface HandleFormSubmissionOptions {
  readonly router: FormNavigationRouter;
  readonly fetch?: typeof fetch | undefined;
  readonly currentUrl?: string | undefined;
  readonly onStatusChange?:
    ((status: FormNavigationStatus, message: string) => void) | undefined;
}

export interface FormSubmissionResult {
  readonly intercepted: boolean;
  readonly bypassedReason?: string | undefined;
  readonly method?: "GET" | "POST" | undefined;
  readonly destination?: string | undefined;
  readonly status?: FormNavigationStatus | undefined;
  readonly error?: string | undefined;
}

export interface FormNavigationOwnerProps {
  readonly router?: FormNavigationRouter | undefined;
  readonly initialFeedback?:
    | {
        readonly status: FormNavigationStatus;
        readonly message: string;
      }
    | undefined;
}

export interface FormNavigationListenerOptions {
  readonly router: FormNavigationRouter;
  readonly target?: EventTarget | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly currentUrl?: string | undefined;
  readonly onStatusChange?:
    ((status: FormNavigationStatus, message: string) => void) | undefined;
}

interface SubmitterLike {
  readonly disabled?: unknown;
  readonly name?: unknown;
  readonly value?: unknown;
  readonly formAction?: string | undefined;
  readonly formMethod?: string | undefined;
  readonly formEnctype?: string | undefined;
  readonly formTarget?: string | undefined;
  readonly formNoValidate?: boolean | undefined;
  readonly getAttribute?: ((name: string) => string | null) | undefined;
  readonly hasAttribute?: ((name: string) => boolean) | undefined;
}

interface ScrollAndFocusSnapshot {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly activeId?: string | undefined;
  readonly activeName?: string | undefined;
  readonly activeTag?: string | undefined;
  readonly activeValue?: string | undefined;
  readonly activePath?: string | undefined;
}

const inFlightForms = new WeakSet<object>();

const FORM_FEEDBACK_DISMISSAL_MS = 5000;
const FORM_FEEDBACK_COUNTDOWN_INTERVAL_MS = 1000;

export function scheduleFeedbackDismissal(
  onCountdownChange: (secondsRemaining: number) => void,
  onDismiss: () => void
): () => void {
  const deadline = Date.now() + FORM_FEEDBACK_DISMISSAL_MS;
  let secondsRemaining = Math.ceil(FORM_FEEDBACK_DISMISSAL_MS / 1000);
  onCountdownChange(secondsRemaining);

  const countdownInterval = setInterval(() => {
    const nextSecondsRemaining = Math.max(
      0,
      Math.ceil((deadline - Date.now()) / 1000)
    );
    if (nextSecondsRemaining === secondsRemaining) return;
    secondsRemaining = nextSecondsRemaining;
    onCountdownChange(secondsRemaining);
  }, FORM_FEEDBACK_COUNTDOWN_INTERVAL_MS);
  const dismissalTimeout = setTimeout(() => {
    clearInterval(countdownInterval);
    if (secondsRemaining !== 0) onCountdownChange(0);
    onDismiss();
  }, FORM_FEEDBACK_DISMISSAL_MS);

  return () => {
    clearInterval(countdownInterval);
    clearTimeout(dismissalTimeout);
  };
}

function isFormSubmitting(form: FormLike): boolean {
  if (typeof form === "object" && form !== null && inFlightForms.has(form)) {
    return true;
  }
  const formElement = form as unknown as HTMLElement;
  return (
    formElement?.dataset?.submitting === "true" ||
    form.getAttribute?.("data-submitting") === "true" ||
    form.getAttribute?.("aria-busy") === "true"
  );
}

function setSubmittingAttributes(form: FormLike, isSubmitting: boolean): void {
  if (typeof form === "object" && form !== null) {
    if (isSubmitting) {
      inFlightForms.add(form);
    } else {
      inFlightForms.delete(form);
    }
  }
  const formElement = form as unknown as HTMLElement;
  if (isSubmitting) {
    if (typeof form.setAttribute === "function") {
      form.setAttribute("aria-busy", "true");
    }
    if (formElement.dataset) {
      formElement.dataset.submitting = "true";
    }
    return;
  }
  if (typeof form.removeAttribute === "function") {
    form.removeAttribute("aria-busy");
  }
  if (formElement.dataset) {
    delete formElement.dataset.submitting;
  }
}

function extractNativeFormData(
  form: HTMLFormElement | FormLike
): URLSearchParams | null {
  if (
    typeof FormData === "undefined" ||
    typeof HTMLFormElement === "undefined" ||
    !(form instanceof HTMLFormElement)
  ) {
    return null;
  }
  try {
    const parameters = new URLSearchParams();
    const fd = new FormData(form);
    for (const [key, value] of fd) {
      if (typeof value === "string") {
        parameters.append(key, value);
      }
    }
    return parameters;
  } catch {
    return null;
  }
}

function appendSelectOptions(
  parameters: URLSearchParams,
  name: string,
  options: Iterable<{
    readonly value: string;
    readonly selected: boolean;
    readonly disabled?: boolean | undefined;
  }>
): void {
  for (const opt of options) {
    if (opt.selected && !opt.disabled) {
      parameters.append(name, opt.value);
    }
  }
}

function appendFormFieldEntry(
  parameters: URLSearchParams,
  element: FormElementLike
): void {
  if (element.disabled === true || !element.name) return;
  const tag = (element.tagName ?? "").toUpperCase();
  const type = (element.type ?? "").toLowerCase();

  if (
    tag === "BUTTON" ||
    type === "submit" ||
    type === "image" ||
    type === "reset" ||
    type === "button"
  ) {
    return;
  }

  if (type === "checkbox" || type === "radio") {
    if (element.checked === true) {
      parameters.append(element.name, element.value ?? "on");
    }
    return;
  }

  if (tag === "SELECT" && element.options) {
    appendSelectOptions(parameters, element.name, element.options);
    return;
  }

  parameters.append(element.name, element.value ?? "");
}

function extractSyntheticFormData(form: FormLike): URLSearchParams {
  const parameters = new URLSearchParams();
  const rawElements = form.elements
    ? Array.from(form.elements)
    : typeof form.querySelectorAll === "function"
      ? Array.from(form.querySelectorAll("input, select, textarea, button"))
      : [];

  for (const element of rawElements as readonly FormElementLike[]) {
    appendFormFieldEntry(parameters, element);
  }
  return parameters;
}

function appendSubmitterEntry(
  parameters: URLSearchParams,
  submitter: HTMLElement | FormElementLike | SubmitterLike | null | undefined
): void {
  if (!submitter) return;
  const sub = submitter as SubmitterLike;
  const isDisabled =
    sub.disabled === true ||
    sub.hasAttribute?.("disabled") === true ||
    (typeof sub.getAttribute === "function" &&
      sub.getAttribute("disabled") !== null);
  if (isDisabled) return;

  const name =
    typeof sub.name === "string"
      ? sub.name
      : typeof sub.getAttribute === "function"
        ? (sub.getAttribute("name") ?? "")
        : "";
  const value =
    typeof sub.value === "string"
      ? sub.value
      : typeof sub.getAttribute === "function"
        ? (sub.getAttribute("value") ?? "")
        : "";

  if (name.length > 0) {
    parameters.append(name, value);
  }
}

/**
Extracts form field entries into URLSearchParams preserving repeated field
names, hidden inputs, disabled-control omission, and explicit submitter name/value.
*/
export function extractFormData(
  form: HTMLFormElement | FormLike,
  submitter?: HTMLElement | FormElementLike | SubmitterLike | null | undefined
): URLSearchParams {
  const parameters =
    extractNativeFormData(form) ?? extractSyntheticFormData(form);
  appendSubmitterEntry(parameters, submitter);
  return parameters;
}

function checkFormConstraints(
  form: FormLike,
  submitter?: SubmitterLike | null
): boolean {
  const sub = submitter as SubmitterLike | null;
  const formElement = form as {
    readonly noValidate?: boolean | undefined;
    readonly getAttribute?: ((name: string) => string | null) | undefined;
    readonly hasAttribute?: ((name: string) => boolean) | undefined;
  };

  const isNoValidate =
    formElement.noValidate === true ||
    formElement.hasAttribute?.("novalidate") === true ||
    (formElement.getAttribute?.("novalidate") !== null &&
      formElement.getAttribute?.("novalidate") !== undefined) ||
    sub?.formNoValidate === true ||
    sub?.hasAttribute?.("formnovalidate") === true ||
    (sub?.getAttribute?.("formnovalidate") !== null &&
      sub?.getAttribute?.("formnovalidate") !== undefined);

  if (isNoValidate) {
    return true;
  }

  if (typeof form.reportValidity === "function") {
    const valid = form.reportValidity();
    if (typeof valid === "boolean") {
      return valid;
    }
  }

  if (typeof form.checkValidity === "function") {
    return form.checkValidity();
  }

  return true;
}

function submitterOverride(
  submitter: SubmitterLike | null,
  attribute: string,
  property: "formAction" | "formMethod" | "formEnctype" | "formTarget"
): string | null {
  if (!submitter) return null;
  if (typeof submitter.getAttribute === "function") {
    return submitter.getAttribute(attribute);
  }
  return submitter[property] ?? null;
}

function isUnsupportedTarget(
  form: FormLike,
  submitter: SubmitterLike | null
): boolean {
  const target = (
    submitterOverride(submitter, "formtarget", "formTarget") ??
    form.getAttribute?.("target") ??
    form.target ??
    ""
  ).trim();
  return target.length > 0 && target.toLowerCase() !== "_self";
}

function resolveMethod(
  form: FormLike,
  submitter: SubmitterLike | null
): string {
  const rawMethod = (
    submitterOverride(submitter, "formmethod", "formMethod") ??
    form.getAttribute?.("method") ??
    form.method ??
    "GET"
  )
    .trim()
    .toUpperCase();
  return rawMethod || "GET";
}

function checkUnsupportedFormPayload(
  form: FormLike,
  submitter: SubmitterLike | null,
  method: string
): string | null {
  const enctype = (
    submitterOverride(submitter, "formenctype", "formEnctype") ??
    form.getAttribute?.("enctype") ??
    form.enctype ??
    ""
  )
    .trim()
    .toLowerCase();
  if (method === "POST") {
    if (enctype === "multipart/form-data") {
      return "multipart_form";
    }
    if (enctype === "text/plain") {
      return "text_plain";
    }
    if (enctype && enctype !== "application/x-www-form-urlencoded") {
      return "unsupported_enctype";
    }
  }
  if (
    typeof form.querySelector === "function" &&
    form.querySelector('input[type="file"]') !== null
  ) {
    return "file_input";
  }
  if (form.elements) {
    for (const element of form.elements) {
      if ((element.type ?? "").toLowerCase() === "file") {
        return "file_input";
      }
    }
  }
  return null;
}

const DATA_NATIVE_SUBMIT = "data-native-submit";
const DATA_NO_INTERCEPT = "data-no-intercept";
const FEEDBACK_TONE_CLASS: Readonly<Record<FormNavigationStatus, string>> = {
  idle: NEUTRAL_TONE_CLASS,
  submitting: ACCENT_TONE_CLASS,
  completed: SUCCESS_TONE_CLASS,
  error: ERROR_TONE_CLASS
};

function hasNativeOptOut(
  form: FormLike,
  submitter?: SubmitterLike | null
): boolean {
  const formElement = form as unknown as HTMLElement;
  const subElement = submitter as unknown as HTMLElement;
  return (
    form.hasAttribute?.(DATA_NATIVE_SUBMIT) === true ||
    form.getAttribute?.(DATA_NO_INTERCEPT) === "true" ||
    (form.getAttribute?.(DATA_NATIVE_SUBMIT) !== null &&
      form.getAttribute?.(DATA_NATIVE_SUBMIT) !== undefined) ||
    formElement?.dataset?.nativeSubmit !== undefined ||
    formElement?.dataset?.noIntercept === "true" ||
    subElement?.hasAttribute?.(DATA_NATIVE_SUBMIT) === true ||
    subElement?.getAttribute?.(DATA_NO_INTERCEPT) === "true" ||
    (subElement?.getAttribute?.(DATA_NATIVE_SUBMIT) !== null &&
      subElement?.getAttribute?.(DATA_NATIVE_SUBMIT) !== undefined) ||
    subElement?.dataset?.nativeSubmit !== undefined ||
    subElement?.dataset?.noIntercept === "true"
  );
}

function captureScrollAndFocus(): ScrollAndFocusSnapshot {
  const win = globalThis.window;
  const document = globalThis.document;
  const activeElement = document?.activeElement as
    HTMLElement | null | undefined;
  return {
    scrollX: win?.scrollX ?? 0,
    scrollY: win?.scrollY ?? 0,
    activeId: activeElement?.id || undefined,
    activeName: (activeElement as HTMLInputElement | null)?.name || undefined,
    activeTag: activeElement?.tagName || undefined,
    activeValue: activeElement?.getAttribute?.("value") ?? undefined,
    activePath: activeElement ? elementPath(activeElement) : undefined
  };
}

/**
The place an element holds in the document.

A name is not an identity. A form can carry a dozen controls called
"roles" -- one per role of one skill, on every row of the catalog -- and
restoring the focus to the first of them moves the operator to a different
control than the one they were working on, which is worse than leaving
the focus alone. The path is the element's position in the document, which
is what "the same control" means once the page has been rebuilt around
it.
*/
function elementPath(element: Element): string | undefined {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current) {
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    const index = Array.from(parent.children).indexOf(current);
    if (index === -1) break;
    segments.unshift(
      `${current.tagName.toLowerCase()}:nth-child(${index + 1})`
    );
    current = parent;
  }
  return segments.length > 0 ? segments.join(" > ") : undefined;
}

/**
The control a snapshot pointed at, if it is still the same control.

The path says where the control was; the tag, the name and the value say
what it was. A control that has moved or been replaced since the snapshot
was taken is not the control the operator was on, so it is not focused.
*/
function resolveSnapshotControl(
  document: Document,
  snapshot: ScrollAndFocusSnapshot
): HTMLElement | null {
  if (!snapshot.activePath) return null;
  let element: Element | null;
  try {
    element = document.querySelector(snapshot.activePath);
  } catch {
    return null;
  }
  if (!element) return null;
  if (snapshot.activeTag && element.tagName !== snapshot.activeTag) return null;
  const name = (element as HTMLInputElement).name;
  if (snapshot.activeName && name !== snapshot.activeName) return null;
  const value = element.getAttribute("value") ?? undefined;
  if (snapshot.activeValue !== undefined && value !== snapshot.activeValue) {
    return null;
  }
  return element as HTMLElement;
}

function escapeCssSelector(value: string): string {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(value);
  }
  return value.replaceAll(/["\\]/gu, String.raw`\$&`);
}

/**
The element the current URL's fragment names, if there is one.

A link that carries a fragment is a link that says where to arrive: the
detail drawer is opened that way, so the operator lands on the panel they
asked for rather than at the top of the list it sits under. The element has
to exist and be focusable -- the drawers carry `tabIndex={-1}` for exactly
this -- and a fragment that names nothing is left to the heading, because a
browser scrolls to a missing fragment's target and gives up.
*/
function fragmentTarget(): HTMLElement | null {
  const hash = globalThis.location?.hash ?? "";
  if (hash.length < 2) return null;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  if (id.length === 0) return null;
  const escaped = escapeCssSelector(id);
  const element = globalThis.document.querySelector<HTMLElement>(
    // eslint-disable-next-line unicorn/require-css-escape -- escapeCssSelector delegates to CSS.escape when available
    `[id="${escaped}"]`
  );
  if (element === null) return null;
  return typeof element.focus === "function" ? element : null;
}

function restoreScrollAndFocus(snapshot: ScrollAndFocusSnapshot): void {
  const win = globalThis.window;
  const document = globalThis.document;
  if (win && typeof win.scrollTo === "function") {
    win.scrollTo(snapshot.scrollX, snapshot.scrollY);
  }
  if (!document || typeof document.querySelector !== "function") return;

  if (snapshot.activeId) {
    const escapedId = escapeCssSelector(snapshot.activeId);
    // eslint-disable-next-line unicorn/require-css-escape -- escapeCssSelector delegates to CSS.escape when available
    const element = document.querySelector<HTMLElement>(`[id="${escapedId}"]`);
    if (element && typeof element.focus === "function") {
      element.focus({ preventScroll: true });
      return;
    }
  }

  const byPath = resolveSnapshotControl(document, snapshot);
  if (byPath && typeof byPath.focus === "function") {
    byPath.focus({ preventScroll: true });
    return;
  }

  // A name identifies a control only when it is unique. When it is not,
  // guessing the first match moves the operator to a different control, so
  // the focus is left where the browser put it instead.
  if (snapshot.activeName) {
    try {
      const escapedName = escapeCssSelector(snapshot.activeName);
      const matches = document.querySelectorAll<HTMLElement>(
        // eslint-disable-next-line unicorn/require-css-escape -- escapeCssSelector delegates to CSS.escape when available
        `[name="${escapedName}"]`
      );
      const only = matches.length === 1 ? matches[0] : undefined;
      if (only) {
        only.focus({ preventScroll: true });
      }
    } catch {
      // Ignore invalid selector queries.
    }
  }
}

// The GET submission has nothing to await: the navigation is fired the way
// its POST sibling fires it, and the scroll and focus are restored here.
// The promise is the caller's return value, so it stays one.
function handleGetSubmission(
  actionUrl: URL,
  parameters: URLSearchParams,
  currentBase: string,
  options: HandleFormSubmissionOptions,
  snapshot: ScrollAndFocusSnapshot
): Promise<FormSubmissionResult> {
  options.onStatusChange?.("submitting", "Applying filters...");
  const destinationUrl = new URL(actionUrl.pathname, actionUrl.origin);
  const finalParameters = new URLSearchParams(actionUrl.search);
  const replacedKeys = new Set<string>();
  for (const [key, value] of parameters) {
    if (!replacedKeys.has(key)) {
      finalParameters.delete(key);
      replacedKeys.add(key);
    }
    finalParameters.append(key, value);
  }
  const searchString = finalParameters.toString();
  destinationUrl.search = searchString.length > 0 ? `?${searchString}` : "";
  if (actionUrl.hash) {
    destinationUrl.hash = actionUrl.hash;
  }
  const destinationHref = `${destinationUrl.pathname}${destinationUrl.search}${destinationUrl.hash}`;

  const currentParsed = new URL(currentBase);
  const currentPathAndQuery = `${currentParsed.pathname}${currentParsed.search}${currentParsed.hash}`;

  if (destinationHref === currentPathAndQuery) {
    options.router.refresh();
  } else {
    // The destination's whole page is asked for before the navigation leaves,
    // so that the address bar and the page move together.
    navigateToWholePage(options.router, destinationHref, "push", {
      scroll: false
    });
  }

  restoreScrollAndFocus(snapshot);
  return Promise.resolve({
    intercepted: true,
    method: "GET",
    destination: destinationHref,
    status: "submitting"
  });
}

const SKILL_PROMPT_SAVE_FAILURES = new Set([
  "conflict",
  "validation",
  "apply-failed",
  "not-found",
  "failed"
]);

function isKnownFailureDestination(destinationUrl: URL): boolean {
  if (destinationUrl.searchParams.get("control") === "failed") {
    return true;
  }
  const saveParameter = destinationUrl.searchParams.get("save");
  return (
    saveParameter !== null && SKILL_PROMPT_SAVE_FAILURES.has(saveParameter)
  );
}

async function handlePostSubmission(
  actionUrl: URL,
  parameters: URLSearchParams,
  form: FormLike,
  currentBase: string,
  options: HandleFormSubmissionOptions,
  snapshot: ScrollAndFocusSnapshot
): Promise<FormSubmissionResult> {
  if (isFormSubmitting(form)) {
    return {
      intercepted: true,
      bypassedReason: "already_submitting"
    };
  }

  options.onStatusChange?.("submitting", "Submitting changes...");
  setSubmittingAttributes(form, true);

  const fetchImpl = options.fetch ?? globalThis.fetch;

  try {
    const response = await fetchImpl(actionUrl.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: parameters.toString(),
      redirect: "follow",
      credentials: "same-origin"
    });

    if (response.status >= 400) {
      // The page re-reads after every write, refused or failed included: a
      // control that showed the operator's choice would otherwise keep
      // showing it, as if the server held it.
      options.router.refresh();
      options.onStatusChange?.(
        "error",
        `Submission failed (${response.status})`
      );
      return {
        intercepted: true,
        method: "POST",
        status: "error",
        error: `Submission failed with status ${response.status}`
      };
    }

    const locHeader = response.headers?.get?.("location");
    const resolvedUrl = locHeader ?? response.url;
    const destinationUrl = new URL(
      resolvedUrl.length === 0 ? currentBase : resolvedUrl,
      currentBase
    );

    const currentParsed = new URL(currentBase);
    if (destinationUrl.origin !== currentParsed.origin) {
      const message =
        "The server redirected this submission outside the Console. No navigation was performed.";
      options.onStatusChange?.("error", message);
      return {
        intercepted: true,
        method: "POST",
        destination: destinationUrl.href,
        status: "error",
        error: message
      };
    }

    const destinationPathAndQuery = `${destinationUrl.pathname}${destinationUrl.search}${destinationUrl.hash}`;
    const currentPathAndQuery = `${currentParsed.pathname}${currentParsed.search}${currentParsed.hash}`;

    if (destinationPathAndQuery === currentPathAndQuery) {
      options.router.refresh();
    } else {
      // The destination is rendered by the server after the write, so it
      // carries the write's result. A second round trip here would race the
      // navigation that is already on its way, and the page that lands would
      // be the one that lost the race.
      navigateToWholePage(options.router, destinationPathAndQuery, "replace", {
        scroll: false
      });
    }

    const isRejected = isKnownFailureDestination(destinationUrl);
    if (isRejected) {
      options.onStatusChange?.(
        "error",
        "The server could not save these changes. Review the notice on this page."
      );
    } else {
      options.onStatusChange?.("completed", "Changes saved.");
    }
    return {
      intercepted: true,
      method: "POST",
      destination: destinationPathAndQuery,
      status: isRejected ? "error" : "completed",
      ...(isRejected && { error: "The server rejected these changes." })
    };
  } catch (error) {
    options.router.refresh();
    const message =
      error instanceof Error ? error.message : "Submission failed";
    options.onStatusChange?.("error", message);
    return {
      intercepted: true,
      method: "POST",
      status: "error",
      error: message
    };
  } finally {
    setSubmittingAttributes(form, false);
    restoreScrollAndFocus(snapshot);
  }
}

/**
Handles same-origin form submissions without full document reloads.

GET requests perform Next client router navigation with preserved search params.
POST requests submit application/x-www-form-urlencoded to same-origin routes,
follow existing 303 redirects, and reconcile destinations via router.refresh
(for same-URL destinations) or router.replace/refresh (for changed URLs).
*/
export function handleFormSubmission(
  event: FormSubmissionEvent,
  options: HandleFormSubmissionOptions
): Promise<FormSubmissionResult> {
  if (event.defaultPrevented === true) {
    return Promise.resolve({
      intercepted: false,
      bypassedReason: "already_prevented"
    });
  }

  const form = event.target as FormLike | null;
  if (!form) {
    return Promise.resolve({
      intercepted: false,
      bypassedReason: "no_form"
    });
  }

  const submitter = (event.submitter ?? null) as SubmitterLike | null;

  if (isFormSubmitting(form)) {
    event.preventDefault();
    return Promise.resolve({
      intercepted: true,
      bypassedReason: "already_submitting"
    });
  }

  if (!checkFormConstraints(form, submitter)) {
    event.preventDefault();
    return Promise.resolve({
      intercepted: true,
      bypassedReason: "validation_failed"
    });
  }

  if (isUnsupportedTarget(form, submitter)) {
    return Promise.resolve({
      intercepted: false,
      bypassedReason: "unsupported_target"
    });
  }

  const method = resolveMethod(form, submitter);
  if (method !== "GET" && method !== "POST") {
    return Promise.resolve({
      intercepted: false,
      bypassedReason: "unsupported_method"
    });
  }

  const unsupportedPayloadReason = checkUnsupportedFormPayload(
    form,
    submitter,
    method
  );
  if (unsupportedPayloadReason !== null) {
    return Promise.resolve({
      intercepted: false,
      bypassedReason: unsupportedPayloadReason
    });
  }

  if (hasNativeOptOut(form, submitter)) {
    return Promise.resolve({
      intercepted: false,
      bypassedReason: "native_opt_out"
    });
  }

  const currentBase =
    options.currentUrl ??
    globalThis.window?.location.href ??
    "http://localhost:3300/";
  const currentOrigin = new URL(currentBase).origin;

  const rawAction = (
    submitterOverride(submitter, "formaction", "formAction") ??
    form.getAttribute?.("action") ??
    form.action ??
    currentBase
  ).trim();

  let actionUrl: URL;
  try {
    actionUrl = new URL(
      rawAction.length === 0 ? currentBase : rawAction,
      currentBase
    );
  } catch {
    return Promise.resolve({
      intercepted: false,
      bypassedReason: "invalid_action_url"
    });
  }

  if (actionUrl.origin !== currentOrigin) {
    return Promise.resolve({
      intercepted: false,
      bypassedReason: "external_origin"
    });
  }

  if (actionUrl.protocol !== "http:" && actionUrl.protocol !== "https:") {
    return Promise.resolve({
      intercepted: false,
      bypassedReason: "unsupported_protocol"
    });
  }

  event.preventDefault();

  const snapshot = captureScrollAndFocus();
  const parameters = extractFormData(form, submitter);

  if (method === "GET") {
    return handleGetSubmission(
      actionUrl,
      parameters,
      currentBase,
      options,
      snapshot
    );
  }

  return handlePostSubmission(
    actionUrl,
    parameters,
    form,
    currentBase,
    options,
    snapshot
  );
}

/**
Registers global form navigation click and submit event listeners.
Returns an unregister cleanup function.
*/
export function registerFormNavigation(
  options: FormNavigationListenerOptions
): () => void {
  const target = options.target ?? globalThis.document;
  if (
    !target ||
    typeof (target as EventTarget).addEventListener !== "function"
  ) {
    return () => {};
  }

  let lastSubmitter: HTMLElement | FormElementLike | null = null;
  let clearSubmitterTimer: ReturnType<typeof setTimeout> | null = null;
  let statusGeneration = 0;

  const handleClick = (event: Event): void => {
    const targetElement = (event as MouseEvent).target;
    if (
      targetElement &&
      typeof (targetElement as Element).closest === "function"
    ) {
      const submitter = (targetElement as Element).closest(
        'button[type="submit"], input[type="submit"], button:not([type]), input[type="image"]'
      );
      if (submitter) {
        lastSubmitter = submitter as HTMLElement;
        if (clearSubmitterTimer !== null) {
          clearTimeout(clearSubmitterTimer);
        }
        clearSubmitterTimer = setTimeout(() => {
          lastSubmitter = null;
          clearSubmitterTimer = null;
        }, 500);
      }
    }
  };

  const handleSubmit = (event: Event): void => {
    const generation = ++statusGeneration;
    const submitEvent = event as SubmitEvent;
    const targetElement = event.target as HTMLElement | null;
    let submitter: HTMLElement | FormElementLike | null = null;
    if (submitEvent.submitter) {
      submitter = submitEvent.submitter as HTMLElement;
    } else if (
      lastSubmitter &&
      targetElement &&
      typeof targetElement.contains === "function" &&
      targetElement.contains(lastSubmitter as Node)
    ) {
      submitter = lastSubmitter;
    }
    if (clearSubmitterTimer !== null) {
      clearTimeout(clearSubmitterTimer);
      clearSubmitterTimer = null;
    }
    lastSubmitter = null;

    void handleFormSubmission(
      {
        defaultPrevented: event.defaultPrevented,
        preventDefault: () => event.preventDefault(),
        target: event.target,
        submitter
      },
      {
        router: options.router,
        fetch: options.fetch,
        currentUrl: options.currentUrl,
        onStatusChange: (status, message) => {
          if (generation === statusGeneration) {
            options.onStatusChange?.(status, message);
          }
        }
      }
    );
  };

  const eventTarget = target as EventTarget;
  eventTarget.addEventListener("click", handleClick as EventListener, {
    capture: true
  });
  eventTarget.addEventListener("submit", handleSubmit as EventListener, {
    capture: false
  });

  return () => {
    if (clearSubmitterTimer !== null) {
      clearTimeout(clearSubmitterTimer);
      clearSubmitterTimer = null;
    }
    eventTarget.removeEventListener(
      "click",
      handleClick as EventListener,
      true
    );
    eventTarget.removeEventListener(
      "submit",
      handleSubmit as EventListener,
      false
    );
  };
}

/**
Root-mounted client island that intercepts same-origin GET/POST form submissions
across the AutoDev Console, replacing native document reloads with client-side
router navigation, in-place server component refreshes, and accessible feedback.
*/
export function FormNavigationOwner({
  router: routerProperty,
  initialFeedback
}: FormNavigationOwnerProps = {}): React.JSX.Element {
  let nextRouter: FormNavigationRouter | null = null;
  try {
    nextRouter = useRouter();
  } catch {
    // In environments without AppRouterContext (such as SSR or unit tests)
  }
  const router = routerProperty ?? nextRouter;

  const [feedback, setFeedback] = React.useState<{
    readonly status: FormNavigationStatus;
    readonly message: string;
    readonly revision: number;
  }>({ ...(initialFeedback ?? { status: "idle", message: "" }), revision: 0 });
  const feedbackReference = React.useRef(feedback);
  const [countdownSeconds, setCountdownSeconds] = React.useState<number | null>(
    feedback.status === "completed" || feedback.status === "error" ? 5 : null
  );
  const [isNavigationPending, startTransition] = React.useTransition();
  const observedNavigationReference = React.useRef(false);

  /**
  Move the focus to the new page's heading after an in-place navigation.
  
  Every navigation in the Console is an in-place one, and the focus the
  operator had on the link they activated was dropped to the document body
  when the page changed: the next Tab started at the skip link and walked the
  whole navigation again before reaching the page they asked for, and a
  screen reader was told nothing at all. Moving the focus to the heading is
  also the announcement -- a focused heading is read out -- so no separate
  live region is needed and nothing is said twice.
  
  This belongs here rather than in the page frame because the page frame is
  replaced by the navigation: the heading it renders survives, but the
  component that rendered it does not, so a component that has to remember
  the previous route cannot tell a navigation from the first load. This
  island is mounted in the root layout, and a layout is the one segment an
  in-place navigation does not replace.
  
  Two guards keep it out of the way. The first route is not a navigation --
  taking the focus on the initial load would steal it from a field the
  operator had already put it in. And a focus that is still somewhere
  deliberate is left alone: a form navigation restores the focus to the field
  that was submitted, and that field must win over the heading.
  
  A navigation that names a fragment lands on that fragment instead. The
  detail drawer is opened by a link carrying the drawer's own anchor, and
  the operator asked for *that panel*, not for the page it sits on -- and the
  fragment is what a browser would have scrolled to, so honouring it keeps
  the two in agreement.
  */
  const currentPathname = usePathname();
  const isFirstPathname = React.useRef(true);
  React.useEffect(() => {
    if (isFirstPathname.current) {
      isFirstPathname.current = false;
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) {
      return;
    }
    const fragment = fragmentTarget();
    if (fragment !== null) {
      fragment.focus({ preventScroll: true });
      return;
    }
    const heading = document.querySelector<HTMLHeadingElement>("main h1");
    heading?.focus({ preventScroll: true });
  }, [currentPathname]);

  // Same-pathname links carrying `#fragment` (such as opening a detail drawer
  // via `/evaluations?evaluationId=...#evaluation-detail-drawer`) keep both
  // `usePathname()` and the table link in place, so watch fragment navigation
  // commits directly and move focus to the requested target element once it
  // settles in the DOM.
  React.useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }
    let pending: { readonly url: string; readonly fragmentId: string } | null =
      null;
    let observer: MutationObserver | null = null;

    const clearPending = (): void => {
      pending = null;
      observer?.disconnect();
      observer = null;
    };

    const tryFocusPending = (): void => {
      if (!pending) return;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (current !== pending.url) return;
      const escaped = escapeCssSelector(pending.fragmentId);
      const element = document.querySelector<HTMLElement>(`[id="${escaped}"]`);
      if (element && typeof element.focus === "function") {
        clearPending();
        element.focus({ preventScroll: true });
      }
    };

    const handleAnchorClick = (event: MouseEvent): void => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.button !== 0
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const anchorTarget = anchor.getAttribute("target");
      if (anchorTarget !== null && anchorTarget !== "_self") return;
      let parsed: URL;
      try {
        parsed = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (parsed.origin !== window.location.origin || parsed.hash.length < 2) {
        return;
      }
      let fragmentId: string;
      try {
        fragmentId = decodeURIComponent(parsed.hash.slice(1));
      } catch {
        return;
      }
      if (fragmentId.length === 0) return;

      clearPending();
      pending = {
        url: `${parsed.pathname}${parsed.search}${parsed.hash}`,
        fragmentId
      };
      observer = new MutationObserver(() => {
        tryFocusPending();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.requestAnimationFrame(() => tryFocusPending());
    };

    const handleHashChange = (): void => {
      tryFocusPending();
    };

    document.addEventListener("click", handleAnchorClick, { capture: true });
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      clearPending();
      document.removeEventListener("click", handleAnchorClick, {
        capture: true
      });
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const publishFeedback = React.useCallback(
    (status: FormNavigationStatus, message: string) => {
      const nextFeedback = {
        status,
        message,
        revision: feedbackReference.current.revision + 1
      };
      feedbackReference.current = nextFeedback;
      setFeedback(nextFeedback);
      setCountdownSeconds(
        status === "completed" || status === "error" ? 5 : null
      );
    },
    []
  );

  const dismissFeedback = React.useCallback(() => {
    const dismissedFeedback = {
      status: "idle" as const,
      message: "",
      revision: feedbackReference.current.revision + 1
    };
    feedbackReference.current = dismissedFeedback;
    setFeedback(dismissedFeedback);
    setCountdownSeconds(null);
  }, []);

  const navigationRouter = React.useMemo<FormNavigationRouter | null>(
    () =>
      router
        ? {
            prefetch: (href) => router.prefetch(href),
            push: (href, options) =>
              startTransition(() => router.push(href, options)),
            replace: (href, options) =>
              startTransition(() => router.replace(href, options)),
            refresh: () => startTransition(() => router.refresh())
          }
        : null,
    [router, startTransition]
  );

  React.useEffect(() => {
    if (isNavigationPending) {
      observedNavigationReference.current = true;
      return;
    }
    if (!observedNavigationReference.current) return;

    observedNavigationReference.current = false;
    if (
      feedbackReference.current.status === "submitting" &&
      feedbackReference.current.message === "Applying filters..."
    ) {
      publishFeedback("completed", "Filters applied.");
    }
  }, [isNavigationPending, publishFeedback]);

  React.useEffect(() => {
    if (feedback.status !== "completed" && feedback.status !== "error") {
      return () => {};
    }

    const revision = feedback.revision;
    return scheduleFeedbackDismissal(
      (secondsRemaining) => {
        if (feedbackReference.current.revision === revision) {
          setCountdownSeconds(secondsRemaining);
        }
      },
      () => {
        if (feedbackReference.current.revision !== revision) return;
        dismissFeedback();
      }
    );
  }, [dismissFeedback, feedback.revision, feedback.status]);

  React.useEffect(() => {
    if (!navigationRouter) {
      return () => {};
    }

    return registerFormNavigation({
      router: navigationRouter,
      onStatusChange: (nextStatus, message) => {
        publishFeedback(nextStatus, message);
      }
    });
  }, [navigationRouter, publishFeedback]);

  React.useEffect(() => {
    if (!navigationRouter || globalThis.window === undefined) {
      return () => {};
    }
    return registerLiveCountRefresh(() => {
      // A refresh that lands while the Console is navigating takes the
      // navigation's place in the router, and the navigation never applies
      // its page: the address bar does not move and the page the operator
      // asked for does not arrive. The refresh runs every five seconds and
      // the navigation to the densest page takes longer than that to issue
      // its request, so the two landed on top of each other every time.
      //
      // So the refresh waits. The counts it refreshes are the counts of the
      // page the operator is on, and a page that is being replaced does not
      // need its counts refreshed.
      if (!shouldRefreshLiveCounts()) return;
      navigationRouter.refresh();
    }, globalThis.window);
  }, [navigationRouter]);

  return React.createElement(
    "div",
    {
      className: `fixed bottom-4 right-4 z-50 flex max-w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-md px-4 py-3 text-sm shadow-lg ${FEEDBACK_TONE_CLASS[feedback.status]}`,
      hidden: feedback.status === "idle",
      "data-form-navigation-owner": "true",
      "data-form-navigation-status": feedback.status
    },
    React.createElement(
      "div",
      {
        role: feedback.status === "error" ? "alert" : "status",
        "aria-live": feedback.status === "error" ? "assertive" : "polite",
        "aria-atomic": "true",
        className: "min-w-0 flex-1"
      },
      feedback.message
    ),
    countdownSeconds !== null &&
      (feedback.status === "completed" || feedback.status === "error")
      ? React.createElement(
          "span",
          {
            "aria-live": "off",
            className: "shrink-0 text-xs",
            "data-feedback-countdown": "true"
          },
          `Dismisses in ${countdownSeconds} ${countdownSeconds === 1 ? "second" : "seconds"}`
        )
      : null,
    feedback.status === "idle"
      ? null
      : React.createElement(
          "button",
          {
            type: "button",
            "aria-label": "Dismiss notification",
            title: "Dismiss notification",
            className:
              "-mr-1 -mt-1 shrink-0 rounded p-1 text-base leading-none hover:bg-black/10",
            onClick: dismissFeedback
          },
          "×"
        )
  );
}
