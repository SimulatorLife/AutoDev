"use client";

import { useRouter } from "next/navigation.js";
import React from "react";

import {
  ACCENT_TONE_CLASS,
  ERROR_TONE_CLASS,
  NEUTRAL_TONE_CLASS,
  SUCCESS_TONE_CLASS
} from "../ui/tones.ts";
import { registerLiveCountRefresh } from "./live-count-refresh.ts";

export type FormNavigationStatus =
  "idle" | "submitting" | "completed" | "error";

export interface FormNavigationRouter {
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
    const params = new URLSearchParams();
    const fd = new FormData(form);
    for (const [key, value] of fd.entries()) {
      if (typeof value === "string") {
        params.append(key, value);
      }
    }
    return params;
  } catch {
    return null;
  }
}

function appendSelectOptions(
  params: URLSearchParams,
  name: string,
  options: Iterable<{
    readonly value: string;
    readonly selected: boolean;
    readonly disabled?: boolean | undefined;
  }>
): void {
  for (const opt of options) {
    if (opt.selected && !opt.disabled) {
      params.append(name, opt.value);
    }
  }
}

function appendFormFieldEntry(
  params: URLSearchParams,
  el: FormElementLike
): void {
  if (el.disabled === true || !el.name) return;
  const tag = (el.tagName ?? "").toUpperCase();
  const type = (el.type ?? "").toLowerCase();

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
    if (el.checked === true) {
      params.append(el.name, el.value ?? "on");
    }
    return;
  }

  if (tag === "SELECT" && el.options) {
    appendSelectOptions(params, el.name, el.options);
    return;
  }

  params.append(el.name, el.value ?? "");
}

function extractSyntheticFormData(form: FormLike): URLSearchParams {
  const params = new URLSearchParams();
  const rawElements = form.elements
    ? Array.from(form.elements)
    : typeof form.querySelectorAll === "function"
      ? Array.from(form.querySelectorAll("input, select, textarea, button"))
      : [];

  for (const el of rawElements as readonly FormElementLike[]) {
    appendFormFieldEntry(params, el);
  }
  return params;
}

function appendSubmitterEntry(
  params: URLSearchParams,
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
    params.append(name, value);
  }
}

/**
 * Extracts form field entries into URLSearchParams preserving repeated field
 * names, hidden inputs, disabled-control omission, and explicit submitter name/value.
 */
export function extractFormData(
  form: HTMLFormElement | FormLike,
  submitter?: HTMLElement | FormElementLike | SubmitterLike | null | undefined
): URLSearchParams {
  const params = extractNativeFormData(form) ?? extractSyntheticFormData(form);
  appendSubmitterEntry(params, submitter);
  return params;
}

function checkFormConstraints(
  form: FormLike,
  submitter?: SubmitterLike | null
): boolean {
  const sub = submitter as SubmitterLike | null;
  const formEl = form as {
    readonly noValidate?: boolean | undefined;
    readonly getAttribute?: ((name: string) => string | null) | undefined;
    readonly hasAttribute?: ((name: string) => boolean) | undefined;
  };

  const isNoValidate =
    formEl.noValidate === true ||
    formEl.hasAttribute?.("novalidate") === true ||
    (formEl.getAttribute?.("novalidate") !== null &&
      formEl.getAttribute?.("novalidate") !== undefined) ||
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
    for (const el of form.elements) {
      if ((el.type ?? "").toLowerCase() === "file") {
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
  const formEl = form as unknown as HTMLElement;
  const subEl = submitter as unknown as HTMLElement;
  return (
    form.hasAttribute?.(DATA_NATIVE_SUBMIT) === true ||
    form.getAttribute?.(DATA_NO_INTERCEPT) === "true" ||
    (form.getAttribute?.(DATA_NATIVE_SUBMIT) !== null &&
      form.getAttribute?.(DATA_NATIVE_SUBMIT) !== undefined) ||
    formEl?.dataset?.nativeSubmit !== undefined ||
    formEl?.dataset?.noIntercept === "true" ||
    subEl?.hasAttribute?.(DATA_NATIVE_SUBMIT) === true ||
    subEl?.getAttribute?.(DATA_NO_INTERCEPT) === "true" ||
    (subEl?.getAttribute?.(DATA_NATIVE_SUBMIT) !== null &&
      subEl?.getAttribute?.(DATA_NATIVE_SUBMIT) !== undefined) ||
    subEl?.dataset?.nativeSubmit !== undefined ||
    subEl?.dataset?.noIntercept === "true"
  );
}

function captureScrollAndFocus(): ScrollAndFocusSnapshot {
  const win = globalThis.window;
  const doc = globalThis.document;
  const activeEl = doc?.activeElement as HTMLElement | null | undefined;
  return {
    scrollX: win?.scrollX ?? 0,
    scrollY: win?.scrollY ?? 0,
    activeId: activeEl?.id || undefined,
    activeName: (activeEl as HTMLInputElement | null)?.name || undefined
  };
}

function escapeCssSelector(value: string): string {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(value);
  }
  return value.replaceAll(/["\\]/gu, String.raw`\$&`);
}

function restoreScrollAndFocus(snapshot: ScrollAndFocusSnapshot): void {
  const win = globalThis.window;
  const doc = globalThis.document;
  if (win && typeof win.scrollTo === "function") {
    win.scrollTo(snapshot.scrollX, snapshot.scrollY);
  }
  if (!doc || typeof doc.querySelector !== "function") return;

  if (snapshot.activeId) {
    const escapedId = escapeCssSelector(snapshot.activeId);
    const el = doc.querySelector<HTMLElement>(`[id="${escapedId}"]`);
    if (el && typeof el.focus === "function") {
      el.focus({ preventScroll: true });
      return;
    }
  }

  if (snapshot.activeName) {
    try {
      const escapedName = escapeCssSelector(snapshot.activeName);
      const el = doc.querySelector<HTMLElement>(`[name="${escapedName}"]`);
      if (el && typeof el.focus === "function") {
        el.focus({ preventScroll: true });
      }
    } catch {
      // Ignore invalid selector queries.
    }
  }
}

function handleGetSubmission(
  actionUrl: URL,
  params: URLSearchParams,
  currentBase: string,
  options: HandleFormSubmissionOptions,
  snapshot: ScrollAndFocusSnapshot
): FormSubmissionResult {
  options.onStatusChange?.("submitting", "Applying filters...");
  const destUrl = new URL(actionUrl.pathname, actionUrl.origin);
  const finalParams = new URLSearchParams(actionUrl.search);
  const replacedKeys = new Set<string>();
  for (const [key, value] of params.entries()) {
    if (!replacedKeys.has(key)) {
      finalParams.delete(key);
      replacedKeys.add(key);
    }
    finalParams.append(key, value);
  }
  const searchStr = finalParams.toString();
  destUrl.search = searchStr.length > 0 ? `?${searchStr}` : "";
  if (actionUrl.hash) {
    destUrl.hash = actionUrl.hash;
  }
  const destHref = `${destUrl.pathname}${destUrl.search}${destUrl.hash}`;

  const currentParsed = new URL(currentBase);
  const currentPathAndQuery = `${currentParsed.pathname}${currentParsed.search}${currentParsed.hash}`;

  if (destHref === currentPathAndQuery) {
    options.router.refresh();
  } else {
    options.router.push(destHref, { scroll: false });
  }

  restoreScrollAndFocus(snapshot);
  return {
    intercepted: true,
    method: "GET",
    destination: destHref,
    status: "submitting"
  };
}

const SKILL_PROMPT_SAVE_FAILURES = new Set([
  "conflict",
  "validation",
  "apply-failed",
  "not-found",
  "failed"
]);

function isKnownFailureDestination(destUrl: URL): boolean {
  if (destUrl.searchParams.get("control") === "failed") {
    return true;
  }
  const saveParam = destUrl.searchParams.get("save");
  if (saveParam !== null && SKILL_PROMPT_SAVE_FAILURES.has(saveParam)) {
    return true;
  }
  return false;
}

async function handlePostSubmission(
  actionUrl: URL,
  params: URLSearchParams,
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
      body: params.toString(),
      redirect: "follow",
      credentials: "same-origin"
    });

    if (response.status >= 400) {
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
    const destUrl = new URL(
      resolvedUrl.length === 0 ? currentBase : resolvedUrl,
      currentBase
    );

    const currentParsed = new URL(currentBase);
    if (destUrl.origin !== currentParsed.origin) {
      const message =
        "The server redirected this submission outside the Console. No navigation was performed.";
      options.onStatusChange?.("error", message);
      return {
        intercepted: true,
        method: "POST",
        destination: destUrl.href,
        status: "error",
        error: message
      };
    }

    const destPathAndQuery = `${destUrl.pathname}${destUrl.search}${destUrl.hash}`;
    const currentPathAndQuery = `${currentParsed.pathname}${currentParsed.search}${currentParsed.hash}`;

    if (destPathAndQuery === currentPathAndQuery) {
      options.router.refresh();
    } else {
      options.router.replace(destPathAndQuery, { scroll: false });
      options.router.refresh();
    }

    const rejected = isKnownFailureDestination(destUrl);
    if (rejected) {
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
      destination: destPathAndQuery,
      status: rejected ? "error" : "completed",
      ...(rejected ? { error: "The server rejected these changes." } : {})
    };
  } catch (error) {
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
 * Handles same-origin form submissions without full document reloads.
 *
 * GET requests perform Next client router navigation with preserved search params.
 * POST requests submit application/x-www-form-urlencoded to same-origin routes,
 * follow existing 303 redirects, and reconcile destinations via router.refresh
 * (for same-URL destinations) or router.replace/refresh (for changed URLs).
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
  const params = extractFormData(form, submitter);

  if (method === "GET") {
    return Promise.resolve(
      handleGetSubmission(actionUrl, params, currentBase, options, snapshot)
    );
  }

  return handlePostSubmission(
    actionUrl,
    params,
    form,
    currentBase,
    options,
    snapshot
  );
}

/**
 * Registers global form navigation click and submit event listeners.
 * Returns an unregister cleanup function.
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
    const targetEl = (event as MouseEvent).target;
    if (targetEl && typeof (targetEl as Element).closest === "function") {
      const submitter = (targetEl as Element).closest(
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
  eventTarget.addEventListener("click", handleClick as EventListener, true);
  eventTarget.addEventListener("submit", handleSubmit as EventListener, false);

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
 * Root-mounted client island that intercepts same-origin GET/POST form submissions
 * across the AutoDev Console, replacing native document reloads with client-side
 * router navigation, in-place server component refreshes, and accessible feedback.
 */
export function FormNavigationOwner({
  router: routerProp,
  initialFeedback
}: FormNavigationOwnerProps = {}): React.JSX.Element {
  let nextRouter: FormNavigationRouter | null = null;
  try {
    nextRouter = useRouter();
  } catch {
    // In environments without AppRouterContext (such as SSR or unit tests)
  }
  const router = routerProp ?? nextRouter;

  const [feedback, setFeedback] = React.useState<{
    readonly status: FormNavigationStatus;
    readonly message: string;
    readonly revision: number;
  }>({ ...(initialFeedback ?? { status: "idle", message: "" }), revision: 0 });
  const feedbackRef = React.useRef(feedback);
  const [countdownSeconds, setCountdownSeconds] = React.useState<number | null>(
    feedback.status === "completed" || feedback.status === "error" ? 5 : null
  );
  const [isNavigationPending, startTransition] = React.useTransition();
  const observedNavigationRef = React.useRef(false);

  const publishFeedback = React.useCallback(
    (status: FormNavigationStatus, message: string) => {
      const nextFeedback = {
        status,
        message,
        revision: feedbackRef.current.revision + 1
      };
      feedbackRef.current = nextFeedback;
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
      revision: feedbackRef.current.revision + 1
    };
    feedbackRef.current = dismissedFeedback;
    setFeedback(dismissedFeedback);
    setCountdownSeconds(null);
  }, []);

  const navigationRouter = React.useMemo<FormNavigationRouter | null>(
    () =>
      router
        ? {
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
      observedNavigationRef.current = true;
      return;
    }
    if (!observedNavigationRef.current) return;

    observedNavigationRef.current = false;
    if (
      feedbackRef.current.status === "submitting" &&
      feedbackRef.current.message === "Applying filters..."
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
        if (feedbackRef.current.revision === revision) {
          setCountdownSeconds(secondsRemaining);
        }
      },
      () => {
        if (feedbackRef.current.revision !== revision) return;
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
    return registerLiveCountRefresh(
      () => navigationRouter.refresh(),
      globalThis.window
    );
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
              "-mr-1 -mt-1 shrink-0 rounded p-1 text-base leading-none hover:bg-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
            onClick: dismissFeedback
          },
          "×"
        )
  );
}
