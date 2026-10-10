import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  extractFormData,
  type FormElementLike,
  type FormLike,
  FormNavigationOwner,
  type FormNavigationOwnerProps,
  type FormNavigationRouter,
  type FormNavigationStatus,
  type FormSubmissionEvent,
  handleFormSubmission,
  registerFormNavigation,
  scheduleFeedbackDismissal
} from "../src/components/navigation/FormNavigationOwner.ts";

interface MockSubmitter extends FormElementLike {
  readonly tagName?: string;
  readonly type?: string;
  readonly name?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly formAction?: string;
  readonly formMethod?: string;
  readonly formEnctype?: string;
  readonly formTarget?: string;
  readonly formNoValidate?: boolean;
  readonly getAttribute?: (name: string) => string | null;
  readonly hasAttribute?: (name: string) => boolean;
  readonly closest?: (selector: string) => MockSubmitter | null;
}

interface MockDomForm extends FormLike {
  readonly action?: string;
  readonly method?: string;
  readonly target?: string;
  readonly enctype?: string;
  readonly noValidate?: boolean;
  readonly elements?: Iterable<FormElementLike>;
  readonly dataset?: Record<string, string | undefined>;
  readonly checkValidity?: () => boolean;
  readonly reportValidity?: () => boolean;
  readonly querySelector?: (selector: string) => Element | null;
  readonly querySelectorAll?: (selector: string) => Iterable<Element>;
  readonly getAttribute?: (name: string) => string | null;
  readonly hasAttribute?: (name: string) => boolean;
  readonly setAttribute?: (name: string, value: string) => void;
  readonly removeAttribute?: (name: string) => void;
  readonly contains?: (node: unknown) => boolean;
}

function createMockRouter(overrides?: Partial<FormNavigationRouter>): {
  router: FormNavigationRouter;
  pushes: {
    href: string;
    options?: { readonly scroll?: boolean } | undefined;
  }[];
  replacements: {
    href: string;
    options?: { readonly scroll?: boolean } | undefined;
  }[];
  refreshes: number;
} {
  const pushes: {
    href: string;
    options?: { readonly scroll?: boolean } | undefined;
  }[] = [];
  const replacements: {
    href: string;
    options?: { readonly scroll?: boolean } | undefined;
  }[] = [];
  let refreshes = 0;

  const router: FormNavigationRouter = {
    push: (href, options) => {
      pushes.push(options ? { href, options } : { href });
      overrides?.push?.(href, options);
    },
    replace: (href, options) => {
      replacements.push(options ? { href, options } : { href });
      overrides?.replace?.(href, options);
    },
    refresh: () => {
      refreshes++;
      overrides?.refresh?.();
    }
  };

  return {
    router,
    pushes,
    replacements,
    get refreshes() {
      return refreshes;
    }
  };
}

test("FormNavigationOwner renders accessible live region with idle status", () => {
  const markup = renderToStaticMarkup(React.createElement(FormNavigationOwner));

  assert.match(markup, /role="status"/u);
  assert.match(markup, /aria-live="polite"/u);
  assert.match(markup, /aria-atomic="true"/u);
  assert.match(markup, /class="fixed bottom-4 right-4/u);
  assert.doesNotMatch(markup, /class="sr-only"/u);
  assert.match(markup, /hidden=""/u);
  assert.match(markup, /data-form-navigation-owner="true"/u);
  assert.match(markup, /data-form-navigation-status="idle"/u);
  assert.doesNotMatch(markup, /aria-label="Dismiss notification"/u);
});

test("FormNavigationOwner renders visible pending status with accessible live announcement", () => {
  const markup = renderToStaticMarkup(
    React.createElement<FormNavigationOwnerProps>(FormNavigationOwner, {
      initialFeedback: {
        status: "submitting",
        message: "Applying filters..."
      }
    })
  );

  assert.match(markup, /role="status"/u);
  assert.match(markup, /aria-live="polite"/u);
  assert.match(markup, /aria-atomic="true"/u);
  assert.match(markup, /class="fixed bottom-4 right-4/u);
  assert.doesNotMatch(markup, /class="sr-only"/u);
  assert.doesNotMatch(markup, /hidden=""/u);
  assert.match(markup, /data-form-navigation-owner="true"/u);
  assert.match(markup, /data-form-navigation-status="submitting"/u);
  assert.match(markup, /Applying filters\.\.\./u);
  assert.match(markup, /aria-label="Dismiss notification"/u);
  assert.doesNotMatch(markup, /data-feedback-countdown="true"/u);
});

test("FormNavigationOwner renders visible actionable error feedback with alert role and assertive live region", () => {
  const markup = renderToStaticMarkup(
    React.createElement<FormNavigationOwnerProps>(FormNavigationOwner, {
      initialFeedback: {
        status: "error",
        message:
          "The server could not save these changes. Review the notice on this page."
      }
    })
  );

  assert.match(markup, /role="alert"/u);
  assert.match(markup, /aria-live="assertive"/u);
  assert.match(markup, /aria-atomic="true"/u);
  assert.match(markup, /class="fixed bottom-4 right-4/u);
  assert.doesNotMatch(markup, /class="sr-only"/u);
  assert.doesNotMatch(markup, /hidden=""/u);
  assert.match(markup, /data-form-navigation-owner="true"/u);
  assert.match(markup, /data-form-navigation-status="error"/u);
  assert.match(
    markup,
    /The server could not save these changes\. Review the notice on this page\./u
  );
  assert.match(markup, /data-feedback-countdown="true"/u);
  assert.match(markup, /Dismisses in 5 seconds/u);
  assert.match(markup, /aria-live="off"/u);
  assert.match(markup, /aria-label="Dismiss notification"/u);
  const liveRegion = markup.match(/<div role="alert"[^>]*>[\s\S]*?<\/div>/u);
  assert.ok(liveRegion);
  assert.doesNotMatch(liveRegion[0], /Dismisses in/u);
});

test("FormNavigationOwner renders visible completed feedback with polite live region", () => {
  const markup = renderToStaticMarkup(
    React.createElement<FormNavigationOwnerProps>(FormNavigationOwner, {
      initialFeedback: {
        status: "completed",
        message: "Changes saved."
      }
    })
  );

  assert.match(markup, /role="status"/u);
  assert.match(markup, /aria-live="polite"/u);
  assert.match(markup, /aria-atomic="true"/u);
  assert.match(markup, /class="fixed bottom-4 right-4/u);
  assert.doesNotMatch(markup, /class="sr-only"/u);
  assert.doesNotMatch(markup, /hidden=""/u);
  assert.match(markup, /data-form-navigation-owner="true"/u);
  assert.match(markup, /data-form-navigation-status="completed"/u);
  assert.match(markup, /Changes saved\./u);
  assert.match(markup, /Dismisses in 5 seconds/u);
  assert.match(markup, /aria-live="off"/u);
  assert.match(markup, /aria-label="Dismiss notification"/u);
});

test("terminal feedback countdown dismisses after five seconds and cleanup cancels it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    const countdown: number[] = [];
    let dismissals = 0;
    const cleanup = scheduleFeedbackDismissal(
      (secondsRemaining) => countdown.push(secondsRemaining),
      () => dismissals++
    );

    assert.deepEqual(countdown, [5]);
    t.mock.timers.tick(1000);
    assert.deepEqual(countdown, [5, 4]);
    for (let second = 0; second < 4; second++) {
      t.mock.timers.tick(1000);
    }
    assert.deepEqual(countdown, [5, 4, 3, 2, 1, 0]);
    assert.equal(dismissals, 1);
    cleanup();

    const cancelledCountdown: number[] = [];
    let cancelledDismissals = 0;
    const cancel = scheduleFeedbackDismissal(
      (secondsRemaining) => cancelledCountdown.push(secondsRemaining),
      () => cancelledDismissals++
    );
    cancel();
    t.mock.timers.tick(5000);
    assert.deepEqual(cancelledCountdown, [5]);
    assert.equal(cancelledDismissals, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test("registerFormNavigation lifecycle: registers listeners on document and unregisters on cleanup", () => {
  const target = new EventTarget();
  let clickListeners = 0;
  let submitListeners = 0;

  const originalAdd = target.addEventListener.bind(target);
  const originalRemove = target.removeEventListener.bind(target);

  target.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (type === "click") clickListeners++;
    if (type === "submit") submitListeners++;
    return originalAdd(type, listener, options);
  }) as typeof target.addEventListener;

  target.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) => {
    if (type === "click") clickListeners--;
    if (type === "submit") submitListeners--;
    return originalRemove(type, listener, options);
  }) as typeof target.removeEventListener;

  const { router } = createMockRouter();
  const cleanup = registerFormNavigation({
    router,
    target
  });

  assert.equal(clickListeners, 1);
  assert.equal(submitListeners, 1);

  cleanup();

  assert.equal(clickListeners, 0);
  assert.equal(submitListeners, 0);
});

test("registerFormNavigation intercepts submit events fired through EventTarget hierarchy", async () => {
  const target = new EventTarget();
  const { router, pushes } = createMockRouter();

  const statuses: FormNavigationStatus[] = [];
  cleanup = registerFormNavigation({
    router,
    target,
    currentUrl: "http://console.test/usage",
    onStatusChange: (status) => statuses.push(status)
  });

  const form: MockDomForm = {
    action: "/usage?tab=activity",
    method: "GET",
    elements: [
      {
        name: "filter",
        value: "active"
      }
    ]
  };

  const nativeEvent = new Event("submit", { cancelable: true });
  Object.defineProperty(nativeEvent, "target", { value: form });

  target.dispatchEvent(nativeEvent);

  assert.deepEqual(statuses, ["submitting"]);

  assert.equal(nativeEvent.defaultPrevented, true);
  assert.deepEqual(pushes, [
    { href: "/usage?tab=activity&filter=active", options: { scroll: false } }
  ]);
  // The React owner announces completion when its App Router transition settles;
  // the low-level listener must not invent completion on a timer.
  assert.deepEqual(statuses, ["submitting"]);

  cleanup();

  // After cleanup, subsequent submit events are ignored
  const unhandledEvent = new Event("submit", { cancelable: true });
  Object.defineProperty(unhandledEvent, "target", { value: form });
  target.dispatchEvent(unhandledEvent);

  assert.equal(unhandledEvent.defaultPrevented, false);
});

let cleanup: () => void = () => {};

test("registerFormNavigation tracks submitter click and includes memory stepper value", async () => {
  const target = new EventTarget();
  const { router, pushes } = createMockRouter();

  const stepperButton: MockSubmitter = {
    tagName: "BUTTON",
    type: "submit",
    name: "step",
    value: "next",
    closest: (selector: string) => {
      if (selector.includes('button[type="submit"]')) return stepperButton;
      return null;
    }
  };

  const form: MockDomForm = {
    action: "/memory?tab=records",
    method: "GET",
    elements: [
      {
        name: "kind",
        value: "procedural"
      }
    ],
    contains: (node) => node === stepperButton
  };

  const teardown = registerFormNavigation({
    router,
    target,
    currentUrl: "http://console.test/memory?tab=records"
  });

  // 1. Simulate button click
  const clickEvent = new Event("click", { bubbles: true, cancelable: true });
  Object.defineProperty(clickEvent, "target", { value: stepperButton });
  target.dispatchEvent(clickEvent);

  // 2. Simulate submit event without explicit submitter on event (browser fallback)
  const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
  Object.defineProperty(submitEvent, "target", { value: form });
  target.dispatchEvent(submitEvent);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(submitEvent.defaultPrevented, true);
  assert.deepEqual(pushes, [
    {
      href: "/memory?tab=records&kind=procedural&step=next",
      options: { scroll: false }
    }
  ]);

  teardown();
});

test("native validation: invalid form prevents default without routing or fetching", async () => {
  let reported = false;
  const form: MockDomForm = {
    action: "/usage",
    method: "GET",
    elements: [{ name: "search", value: "" }],
    checkValidity: () => false,
    reportValidity: () => {
      reported = true;
      return false;
    }
  };

  const nativeEvent = new Event("submit", { cancelable: true });
  const submitEvent: FormSubmissionEvent = {
    get defaultPrevented() {
      return nativeEvent.defaultPrevented;
    },
    preventDefault: () => nativeEvent.preventDefault(),
    target: form
  };

  const { router, pushes } = createMockRouter();
  const result = await handleFormSubmission(submitEvent, {
    router,
    currentUrl: "http://console.test/usage"
  });

  assert.equal(nativeEvent.defaultPrevented, true);
  assert.equal(reported, true);
  assert.equal(pushes.length, 0);
  assert.equal(result.intercepted, true);
  assert.equal(result.bypassedReason, "validation_failed");
});

test("native validation: novalidate on form or formnovalidate on submitter bypasses constraint check", async () => {
  // Form with noValidate = true
  const formWithNovalidate: MockDomForm = {
    action: "/usage",
    method: "GET",
    noValidate: true,
    checkValidity: () => false,
    elements: [{ name: "query", value: "test" }]
  };

  const event1 = new Event("submit", { cancelable: true });
  const submitEvent1: FormSubmissionEvent = {
    get defaultPrevented() {
      return event1.defaultPrevented;
    },
    preventDefault: () => event1.preventDefault(),
    target: formWithNovalidate
  };

  const { router: router1, pushes: pushes1 } = createMockRouter();
  const result1 = await handleFormSubmission(submitEvent1, {
    router: router1,
    currentUrl: "http://console.test/usage"
  });

  assert.equal(event1.defaultPrevented, true);
  assert.equal(result1.intercepted, true);
  assert.deepEqual(pushes1, [
    { href: "/usage?query=test", options: { scroll: false } }
  ]);

  // Submitter with formNoValidate = true
  const formStandard: MockDomForm = {
    action: "/usage",
    method: "GET",
    checkValidity: () => false,
    elements: [{ name: "query", value: "bypass" }]
  };
  const submitterWithFormnovalidate: MockSubmitter = {
    tagName: "BUTTON",
    type: "submit",
    formNoValidate: true
  };

  const event2 = new Event("submit", { cancelable: true });
  const submitEvent2: FormSubmissionEvent = {
    get defaultPrevented() {
      return event2.defaultPrevented;
    },
    preventDefault: () => event2.preventDefault(),
    target: formStandard,
    submitter: submitterWithFormnovalidate
  };

  const { router: router2, pushes: pushes2 } = createMockRouter();
  const result2 = await handleFormSubmission(submitEvent2, {
    router: router2,
    currentUrl: "http://console.test/usage"
  });

  assert.equal(event2.defaultPrevented, true);
  assert.equal(result2.intercepted, true);
  assert.deepEqual(pushes2, [
    { href: "/usage?query=bypass", options: { scroll: false } }
  ]);
});

test("same-origin/CSRF semantics: external-origin form bypasses interception allowing native submit", async () => {
  const form: MockDomForm = {
    action: "https://auth.external.com/oauth/authorize",
    method: "POST",
    elements: [{ name: "clientId", value: "abc" }]
  };

  const nativeEvent = new Event("submit", { cancelable: true });
  const submitEvent: FormSubmissionEvent = {
    get defaultPrevented() {
      return nativeEvent.defaultPrevented;
    },
    preventDefault: () => nativeEvent.preventDefault(),
    target: form
  };

  const { router } = createMockRouter();
  let fetchCalled = false;
  const result = await handleFormSubmission(submitEvent, {
    router,
    currentUrl: "http://console.test/login",
    fetch: async () => {
      fetchCalled = true;
      return new Response();
    }
  });

  assert.equal(nativeEvent.defaultPrevented, false);
  assert.equal(fetchCalled, false);
  assert.equal(result.intercepted, false);
  assert.equal(result.bypassedReason, "external_origin");
});

test("GET submission serializes repeated fields, omits disabled controls, and preserves hash", async () => {
  const form: MockDomForm = {
    action: "/explore#section-results",
    method: "GET",
    elements: [
      { name: "tags", value: "react" },
      { name: "tags", value: "typescript" },
      { name: "tags", value: "nextjs" },
      { name: "disabledField", value: "ignored", disabled: true },
      { name: "flag", value: "active", type: "checkbox", checked: true },
      {
        name: "inactiveFlag",
        value: "inactive",
        type: "checkbox",
        checked: false
      },
      {
        name: "role",
        tagName: "SELECT",
        options: [
          { value: "admin", selected: true },
          { value: "guest", selected: false },
          { value: "owner", selected: true }
        ]
      }
    ]
  };

  const nativeEvent = new Event("submit", { cancelable: true });
  const submitEvent: FormSubmissionEvent = {
    get defaultPrevented() {
      return nativeEvent.defaultPrevented;
    },
    preventDefault: () => nativeEvent.preventDefault(),
    target: form
  };

  const { router, pushes } = createMockRouter();
  const result = await handleFormSubmission(submitEvent, {
    router,
    currentUrl: "http://console.test/explore"
  });

  assert.equal(nativeEvent.defaultPrevented, true);
  assert.equal(result.intercepted, true);
  assert.deepEqual(pushes, [
    {
      href: "/explore?tags=react&tags=typescript&tags=nextjs&flag=active&role=admin&role=owner#section-results",
      options: { scroll: false }
    }
  ]);
});

test("GET submission refreshes in-place when destination matches current URL", async () => {
  const form: MockDomForm = {
    action: "/usage?tab=activity",
    method: "GET",
    elements: [{ name: "tab", value: "activity" }]
  };

  const nativeEvent = new Event("submit", { cancelable: true });
  const submitEvent: FormSubmissionEvent = {
    get defaultPrevented() {
      return nativeEvent.defaultPrevented;
    },
    preventDefault: () => nativeEvent.preventDefault(),
    target: form
  };

  let refreshes = 0;
  const { router, pushes } = createMockRouter({
    refresh: () => {
      refreshes++;
    }
  });

  const result = await handleFormSubmission(submitEvent, {
    router,
    currentUrl: "http://console.test/usage?tab=activity"
  });

  assert.equal(nativeEvent.defaultPrevented, true);
  assert.equal(result.intercepted, true);
  assert.equal(pushes.length, 0);
  assert.equal(refreshes, 1);
});

test("POST submission sends application/x-www-form-urlencoded with same-origin credentials and follows 303 redirect", async () => {
  const form: MockDomForm = {
    action: "/api/memory",
    method: "POST",
    elements: [
      { name: "action", value: "verify" },
      { name: "recordId", value: "rec-123" },
      { name: "reason", value: "Audited revision" }
    ],
    dataset: {}
  };

  const submitter: MockSubmitter = {
    tagName: "BUTTON",
    type: "submit",
    name: "step",
    value: "confirm"
  };

  const nativeEvent = new Event("submit", { cancelable: true });
  const submitEvent: FormSubmissionEvent = {
    get defaultPrevented() {
      return nativeEvent.defaultPrevented;
    },
    preventDefault: () => nativeEvent.preventDefault(),
    target: form,
    submitter
  };

  let requestUrl = "";
  let requestHeaders: HeadersInit | undefined;
  let requestBody: BodyInit | null | undefined;
  let requestCredentials: RequestCredentials | undefined;

  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = init?.headers;
    requestBody = init?.body;
    requestCredentials = init?.credentials;
    return new Response(null, {
      status: 200,
      headers: {
        location: "/memory?tab=records&recordId=rec-123"
      }
    });
  };

  let refreshes = 0;
  const { router, replacements } = createMockRouter({
    refresh: () => {
      refreshes++;
    }
  });

  const statuses: { status: FormNavigationStatus; message: string }[] = [];
  const result = await handleFormSubmission(submitEvent, {
    router,
    fetch: fetchImpl,
    currentUrl: "http://console.test/memory",
    onStatusChange: (status, message) => statuses.push({ status, message })
  });

  assert.equal(nativeEvent.defaultPrevented, true);
  assert.equal(requestUrl, "http://console.test/api/memory");
  assert.deepEqual(requestHeaders, {
    "Content-Type": "application/x-www-form-urlencoded"
  });
  assert.equal(requestCredentials, "same-origin");
  assert.equal(typeof requestBody, "string");
  assert.equal(
    requestBody,
    "action=verify&recordId=rec-123&reason=Audited+revision&step=confirm"
  );
  assert.deepEqual(replacements, [
    {
      href: "/memory?tab=records&recordId=rec-123",
      options: { scroll: false }
    }
  ]);
  assert.equal(refreshes, 1);
  assert.equal(result.intercepted, true);
  assert.equal(result.status, "completed");
  assert.deepEqual(statuses, [
    { status: "submitting", message: "Submitting changes..." },
    { status: "completed", message: "Changes saved." }
  ]);
});

test("POST submission handles HTTP error by reporting error status and announcement without document reload", async () => {
  const form: MockDomForm = {
    action: "/api/memory",
    method: "POST",
    elements: [{ name: "action", value: "purge" }]
  };

  const nativeEvent = new Event("submit", { cancelable: true });
  const submitEvent: FormSubmissionEvent = {
    get defaultPrevented() {
      return nativeEvent.defaultPrevented;
    },
    preventDefault: () => nativeEvent.preventDefault(),
    target: form
  };

  const fetchImpl: typeof fetch = async () => {
    return new Response("Validation failed", { status: 400 });
  };

  const statuses: { status: FormNavigationStatus; message: string }[] = [];
  const { router, replacements } = createMockRouter();
  const result = await handleFormSubmission(submitEvent, {
    router,
    fetch: fetchImpl,
    currentUrl: "http://console.test/memory",
    onStatusChange: (status, message) => statuses.push({ status, message })
  });

  assert.equal(nativeEvent.defaultPrevented, true);
  assert.equal(replacements.length, 0);
  assert.equal(result.intercepted, true);
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /400/u);
  assert.deepEqual(statuses, [
    { status: "submitting", message: "Submitting changes..." },
    { status: "error", message: "Submission failed (400)" }
  ]);
});

test("POST followed redirects surface provider, model, skill, and prompt failures", async () => {
  const failedRedirects = [
    "/providers?control=failed",
    "/models?control=failed",
    "/skills?save=conflict",
    "/skills?save=validation",
    "/skills?save=not-found",
    "/prompts/example?save=apply-failed",
    "/prompts/example?save=failed"
  ];

  for (const redirectPath of failedRedirects) {
    const form: MockDomForm = {
      action: "/api/save",
      method: "POST",
      elements: [{ name: "value", value: "updated" }]
    };
    const statuses: { status: FormNavigationStatus; message: string }[] = [];
    const mockRouter = createMockRouter();
    const { router, replacements } = mockRouter;
    const fetchImpl: typeof fetch = async () =>
      ({
        status: 200,
        url: `http://console.test${redirectPath}`,
        headers: new Headers()
      }) as Response;

    const result = await handleFormSubmission(
      {
        defaultPrevented: false,
        preventDefault: () => {},
        target: form
      },
      {
        router,
        fetch: fetchImpl,
        currentUrl: "http://console.test/current",
        onStatusChange: (status, message) => statuses.push({ status, message })
      }
    );

    assert.equal(result.status, "error", redirectPath);
    assert.match(result.error ?? "", /rejected/u, redirectPath);
    assert.deepEqual(replacements, [
      { href: redirectPath, options: { scroll: false } }
    ]);
    assert.equal(mockRouter.refreshes, 1);
    assert.deepEqual(statuses, [
      { status: "submitting", message: "Submitting changes..." },
      {
        status: "error",
        message:
          "The server could not save these changes. Review the notice on this page."
      }
    ]);
    assert.equal(
      statuses.some((entry) => entry.message === "Changes saved."),
      false
    );
  }
});

test("POST followed redirect to same URL with failure refreshes without replace", async () => {
  const form: MockDomForm = {
    action: "/api/save",
    method: "POST",
    elements: [{ name: "value", value: "retry" }]
  };
  const statuses: { status: FormNavigationStatus; message: string }[] = [];
  const mockRouter = createMockRouter();
  const fetchImpl: typeof fetch = async () =>
    ({
      status: 200,
      url: "http://console.test/skills?save=conflict",
      headers: new Headers()
    }) as Response;

  const result = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => {},
      target: form
    },
    {
      router: mockRouter.router,
      fetch: fetchImpl,
      currentUrl: "http://console.test/skills?save=conflict",
      onStatusChange: (status, message) => statuses.push({ status, message })
    }
  );

  assert.equal(result.status, "error");
  assert.equal(mockRouter.replacements.length, 0);
  assert.equal(mockRouter.refreshes, 1);
  assert.deepEqual(statuses, [
    { status: "submitting", message: "Submitting changes..." },
    {
      status: "error",
      message:
        "The server could not save these changes. Review the notice on this page."
    }
  ]);
});

test("race conditions & duplicate submissions: concurrent submit on in-flight form is blocked", async () => {
  let resolveFirstFetch!: (value: Response) => void;
  const firstFetchPromise = new Promise<Response>((resolve) => {
    resolveFirstFetch = resolve;
  });

  let fetchCount = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCount++;
    return firstFetchPromise;
  };

  const form: MockDomForm = {
    action: "/api/memory",
    method: "POST",
    elements: [{ name: "id", value: "1" }],
    dataset: {}
  };

  const event1 = new Event("submit", { cancelable: true });
  const submitEvent1: FormSubmissionEvent = {
    get defaultPrevented() {
      return event1.defaultPrevented;
    },
    preventDefault: () => event1.preventDefault(),
    target: form
  };

  const { router } = createMockRouter();

  // First submission starts
  const submission1Promise = handleFormSubmission(submitEvent1, {
    router,
    fetch: fetchImpl,
    currentUrl: "http://console.test/memory"
  });

  // Second submission attempted on the same form while first is in-flight
  const event2 = new Event("submit", { cancelable: true });
  const submitEvent2: FormSubmissionEvent = {
    get defaultPrevented() {
      return event2.defaultPrevented;
    },
    preventDefault: () => event2.preventDefault(),
    target: form
  };

  const submission2Result = await handleFormSubmission(submitEvent2, {
    router,
    fetch: fetchImpl,
    currentUrl: "http://console.test/memory"
  });

  assert.equal(event2.defaultPrevented, true);
  assert.equal(submission2Result.intercepted, true);
  assert.equal(submission2Result.bypassedReason, "already_submitting");
  assert.equal(fetchCount, 1);

  // Complete first submission
  resolveFirstFetch(
    new Response(null, { status: 200, headers: { location: "/memory" } })
  );
  await submission1Promise;

  assert.equal(fetchCount, 1);
});

test("unsupported features bypass safely: multipart, file input, unsupported target and methods", async () => {
  const { router } = createMockRouter();

  // 1. enctype multipart
  const multipartForm: MockDomForm = {
    action: "/api/upload",
    method: "POST",
    enctype: "multipart/form-data"
  };
  const event1 = new Event("submit", { cancelable: true });
  const res1 = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => event1.preventDefault(),
      target: multipartForm
    },
    { router, currentUrl: "http://console.test/" }
  );
  assert.equal(event1.defaultPrevented, false);
  assert.equal(res1.intercepted, false);
  assert.equal(res1.bypassedReason, "multipart_form");

  // 2. input[type=file]
  const fileForm: MockDomForm = {
    action: "/api/upload",
    method: "POST",
    elements: [{ type: "file", name: "attachment" }]
  };
  const event2 = new Event("submit", { cancelable: true });
  const res2 = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => event2.preventDefault(),
      target: fileForm
    },
    { router, currentUrl: "http://console.test/" }
  );
  assert.equal(event2.defaultPrevented, false);
  assert.equal(res2.intercepted, false);
  assert.equal(res2.bypassedReason, "file_input");

  // 3. target _blank
  const blankForm: MockDomForm = {
    action: "/usage",
    method: "GET",
    target: "_blank"
  };
  const event3 = new Event("submit", { cancelable: true });
  const res3 = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => event3.preventDefault(),
      target: blankForm
    },
    { router, currentUrl: "http://console.test/" }
  );
  assert.equal(event3.defaultPrevented, false);
  assert.equal(res3.intercepted, false);
  assert.equal(res3.bypassedReason, "unsupported_target");

  // 4. method dialog
  const dialogForm: MockDomForm = {
    action: "/dialog",
    method: "dialog"
  };
  const event4 = new Event("submit", { cancelable: true });
  const res4 = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => event4.preventDefault(),
      target: dialogForm
    },
    { router, currentUrl: "http://console.test/" }
  );
  assert.equal(event4.defaultPrevented, false);
  assert.equal(res4.intercepted, false);
  assert.equal(res4.bypassedReason, "unsupported_method");

  // 5. data-native-submit opt out
  const optOutForm: MockDomForm = {
    action: "/custom",
    method: "POST",
    dataset: { nativeSubmit: "true" }
  };
  const event5 = new Event("submit", { cancelable: true });
  const res5 = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => event5.preventDefault(),
      target: optOutForm
    },
    { router, currentUrl: "http://console.test/" }
  );
  assert.equal(event5.defaultPrevented, false);
  assert.equal(res5.intercepted, false);
  assert.equal(res5.bypassedReason, "native_opt_out");

  // 6. enctype text/plain on form
  const textPlainForm: MockDomForm = {
    action: "/api/text",
    method: "POST",
    enctype: "text/plain"
  };
  const event6 = new Event("submit", { cancelable: true });
  const res6 = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => event6.preventDefault(),
      target: textPlainForm
    },
    { router, currentUrl: "http://console.test/" }
  );
  assert.equal(event6.defaultPrevented, false);
  assert.equal(res6.intercepted, false);
  assert.equal(res6.bypassedReason, "text_plain");

  // 7. formenctype text/plain on submitter
  const urlEncodedForm: MockDomForm = {
    action: "/api/text",
    method: "POST"
  };
  const textPlainSubmitter: MockSubmitter = {
    tagName: "BUTTON",
    type: "submit",
    formEnctype: "text/plain"
  };
  const event7 = new Event("submit", { cancelable: true });
  const res7 = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => event7.preventDefault(),
      target: urlEncodedForm,
      submitter: textPlainSubmitter
    },
    { router, currentUrl: "http://console.test/" }
  );
  assert.equal(event7.defaultPrevented, false);
  assert.equal(res7.intercepted, false);
  assert.equal(res7.bypassedReason, "text_plain");

  // 8. GET forms with enctype text/plain are not bypassed; they continue URL-encoded
  const getFormWithTextPlain: MockDomForm = {
    action: "/search",
    method: "GET",
    enctype: "text/plain",
    elements: [{ name: "q", value: "hello world" }]
  };
  const event8 = new Event("submit", { cancelable: true });
  const getRouter = createMockRouter();
  const res8 = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => event8.preventDefault(),
      target: getFormWithTextPlain
    },
    { router: getRouter.router, currentUrl: "http://console.test/" }
  );
  assert.equal(event8.defaultPrevented, true);
  assert.equal(res8.intercepted, true);
  assert.deepEqual(getRouter.pushes, [
    { href: "/search?q=hello+world", options: { scroll: false } }
  ]);
});

test("extractFormData extracts synthetic form fields and appends submitter entry accurately", () => {
  const form: FormLike = {
    elements: [
      { name: "token", value: "xyz" },
      { name: "option", type: "radio", value: "one", checked: false },
      { name: "option", type: "radio", value: "two", checked: true },
      { name: "flag", type: "checkbox", checked: true }, // defaults to "on"
      { name: "disabled", value: "skip", disabled: true }
    ]
  };
  const submitter: FormElementLike = {
    name: "action",
    value: "save"
  };

  const params = extractFormData(form, submitter);
  assert.equal(params.toString(), "token=xyz&option=two&flag=on&action=save");
});

test("scroll and focus: preserves window scroll position and restores element focus with preventScroll", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  let scrolledX = -1;
  let scrolledY = -1;
  let focusedId = "";
  let preventScrollOption: boolean | undefined;

  const mockFocusedElement = {
    id: "search-input",
    focus: (options?: { preventScroll?: boolean }) => {
      focusedId = "search-input";
      preventScrollOption = options?.preventScroll;
    }
  };

  const mockWindow = {
    scrollX: 120,
    scrollY: 340,
    scrollTo: (x: number, y: number) => {
      scrolledX = x;
      scrolledY = y;
    }
  };

  const mockDocument = {
    activeElement: mockFocusedElement,
    querySelector: (selector: string) => {
      if (selector === "#search-input" || selector === '[id="search-input"]') {
        return mockFocusedElement;
      }
      return null;
    }
  };

  Object.defineProperty(globalThis, "window", {
    value: mockWindow,
    configurable: true,
    writable: true
  });
  Object.defineProperty(globalThis, "document", {
    value: mockDocument,
    configurable: true,
    writable: true
  });

  try {
    const form: MockDomForm = {
      action: "/usage",
      method: "GET",
      elements: [{ name: "q", value: "test" }]
    };

    const nativeEvent = new Event("submit", { cancelable: true });
    const submitEvent: FormSubmissionEvent = {
      get defaultPrevented() {
        return nativeEvent.defaultPrevented;
      },
      preventDefault: () => nativeEvent.preventDefault(),
      target: form
    };

    const { router } = createMockRouter();
    await handleFormSubmission(submitEvent, {
      router,
      currentUrl: "http://console.test/usage"
    });

    assert.equal(scrolledX, 120);
    assert.equal(scrolledY, 340);
    assert.equal(focusedId, "search-input");
    assert.equal(preventScrollOption, true);
  } finally {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true
    });
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true
    });
  }
});

test("submitter button overrides: formaction, formmethod, and disabled submitter omission", async () => {
  const form: MockDomForm = {
    action: "/api/default",
    method: "GET",
    elements: [{ name: "filter", value: "all" }]
  };

  // Submitter overriding action to POST /api/override
  const submitterOverride: MockSubmitter = {
    tagName: "BUTTON",
    type: "submit",
    formAction: "/api/override",
    formMethod: "POST",
    name: "action",
    value: "execute"
  };

  const event1 = new Event("submit", { cancelable: true });
  const submitEvent1: FormSubmissionEvent = {
    get defaultPrevented() {
      return event1.defaultPrevented;
    },
    preventDefault: () => event1.preventDefault(),
    target: form,
    submitter: submitterOverride
  };

  let postedUrl = "";
  let postedBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    postedUrl = String(input);
    postedBody = String(init?.body);
    return new Response(null, {
      status: 200,
      headers: { location: "/success" }
    });
  };

  const { router, replacements } = createMockRouter();
  const res1 = await handleFormSubmission(submitEvent1, {
    router,
    fetch: fetchImpl,
    currentUrl: "http://console.test/page"
  });

  assert.equal(res1.intercepted, true);
  assert.equal(res1.method, "POST");
  assert.equal(postedUrl, "http://console.test/api/override");
  assert.equal(postedBody, "filter=all&action=execute");
  assert.deepEqual(replacements, [
    { href: "/success", options: { scroll: false } }
  ]);

  // Disabled submitter should not include its name/value
  const disabledSubmitter: MockSubmitter = {
    tagName: "BUTTON",
    type: "submit",
    disabled: true,
    name: "action",
    value: "should-not-include"
  };

  const formGet: MockDomForm = {
    action: "/search",
    method: "GET",
    elements: [{ name: "q", value: "hello" }]
  };

  const event2 = new Event("submit", { cancelable: true });
  const submitEvent2: FormSubmissionEvent = {
    get defaultPrevented() {
      return event2.defaultPrevented;
    },
    preventDefault: () => event2.preventDefault(),
    target: formGet,
    submitter: disabledSubmitter
  };

  const { router: router2, pushes: pushes2 } = createMockRouter();
  await handleFormSubmission(submitEvent2, {
    router: router2,
    currentUrl: "http://console.test/search"
  });

  assert.deepEqual(pushes2, [
    { href: "/search?q=hello", options: { scroll: false } }
  ]);
});

test("native submitter default properties do not override a POST form", async () => {
  const form: MockDomForm = {
    action: "/api/providers/codex/limits",
    method: "POST",
    enctype: "application/x-www-form-urlencoded",
    elements: [
      { name: "provider", value: "codex" },
      { name: "perSession", value: "4" },
      { name: "acrossSessions", value: "12" }
    ]
  };
  const submitter: MockSubmitter = {
    tagName: "BUTTON",
    type: "submit",
    // These are the browser IDL defaults for an ordinary submit button with no
    // form* attributes. They must not hide the owning form's POST action.
    formAction: "about:blank",
    formMethod: "",
    formEnctype: "",
    formTarget: "",
    name: "setPerSession",
    value: "3",
    getAttribute: () => null
  };
  const nativeEvent = new Event("submit", { cancelable: true });
  const submitEvent: FormSubmissionEvent = {
    get defaultPrevented() {
      return nativeEvent.defaultPrevented;
    },
    preventDefault: () => nativeEvent.preventDefault(),
    target: form,
    submitter
  };

  let requestUrl = "";
  let requestMethod = "";
  let requestBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestMethod = String(init?.method);
    requestBody = String(init?.body);
    return {
      status: 200,
      url: "http://console.test/providers",
      headers: new Headers()
    } as Response;
  };
  const mockRouter = createMockRouter();
  const result = await handleFormSubmission(submitEvent, {
    router: mockRouter.router,
    fetch: fetchImpl,
    currentUrl: "http://console.test/providers"
  });

  assert.equal(nativeEvent.defaultPrevented, true);
  assert.equal(result.method, "POST");
  assert.equal(requestUrl, "http://console.test/api/providers/codex/limits");
  assert.equal(requestMethod, "POST");
  assert.equal(
    requestBody,
    "provider=codex&perSession=4&acrossSessions=12&setPerSession=3"
  );
  assert.deepEqual(mockRouter.pushes, []);
  assert.equal(mockRouter.refreshes, 1);
});

test("native submitter default encoding and target defer to the owning form", async () => {
  const { router } = createMockRouter();
  const textPlainForm: MockDomForm = {
    action: "/api/upload",
    method: "POST",
    enctype: "text/plain",
    target: "_self"
  };
  const defaultSubmitter: MockSubmitter = {
    tagName: "BUTTON",
    type: "submit",
    formEnctype: "",
    formTarget: "",
    getAttribute: () => null
  };
  const textPlainEvent = new Event("submit", { cancelable: true });
  const textPlainResult = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => textPlainEvent.preventDefault(),
      target: textPlainForm,
      submitter: defaultSubmitter
    },
    { router, currentUrl: "http://console.test/providers" }
  );

  assert.equal(textPlainEvent.defaultPrevented, false);
  assert.equal(textPlainResult.intercepted, false);
  assert.equal(textPlainResult.bypassedReason, "text_plain");

  const newWindowForm: MockDomForm = {
    action: "/api/upload",
    method: "POST",
    enctype: "application/x-www-form-urlencoded",
    target: "_blank"
  };
  const targetEvent = new Event("submit", { cancelable: true });
  const targetResult = await handleFormSubmission(
    {
      defaultPrevented: false,
      preventDefault: () => targetEvent.preventDefault(),
      target: newWindowForm,
      submitter: defaultSubmitter
    },
    { router, currentUrl: "http://console.test/providers" }
  );
  assert.equal(targetEvent.defaultPrevented, false);
  assert.equal(targetResult.intercepted, false);
  assert.equal(targetResult.bypassedReason, "unsupported_target");
});

test("same-origin POST followed to external origin never unloads Console and surfaces actionable error", async () => {
  const originalWindow = globalThis.window;
  let assignedUrl = "";

  const mockWindow = {
    location: {
      assign: (url: string) => {
        assignedUrl = url;
      }
    }
  };

  Object.defineProperty(globalThis, "window", {
    value: mockWindow,
    configurable: true,
    writable: true
  });

  try {
    const form: MockDomForm = {
      action: "/api/auth/sso",
      method: "POST",
      elements: [{ name: "provider", value: "google" }]
    };

    const nativeEvent = new Event("submit", { cancelable: true });
    const submitEvent: FormSubmissionEvent = {
      get defaultPrevented() {
        return nativeEvent.defaultPrevented;
      },
      preventDefault: () => nativeEvent.preventDefault(),
      target: form
    };

    const fetchImpl: typeof fetch = async () => {
      return new Response(null, {
        status: 200,
        headers: { location: "https://accounts.google.com/o/oauth2/auth" }
      });
    };

    const statuses: { status: FormNavigationStatus; message: string }[] = [];
    const mockRouter = createMockRouter();
    const result = await handleFormSubmission(submitEvent, {
      router: mockRouter.router,
      fetch: fetchImpl,
      currentUrl: "http://console.test/login",
      onStatusChange: (status, message) => statuses.push({ status, message })
    });

    assert.equal(result.intercepted, true);
    assert.equal(result.status, "error");
    assert.equal(
      result.destination,
      "https://accounts.google.com/o/oauth2/auth"
    );
    assert.match(result.error ?? "", /outside the Console|external origin/u);
    assert.equal(mockRouter.replacements.length, 0); // No Next router replace for external origin
    assert.equal(mockRouter.refreshes, 0);
    assert.equal(assignedUrl, ""); // Never unloads the Console via window.location.assign
    assert.deepEqual(statuses, [
      { status: "submitting", message: "Submitting changes..." },
      {
        status: "error",
        message:
          "The server redirected this submission outside the Console. No navigation was performed."
      }
    ]);
  } finally {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true
    });
  }
});
