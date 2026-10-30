import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ConsoleErrorPage,
  ConsoleNotFoundPage
} from "../src/components/layout/AppShell.ts";

test("ConsoleNotFoundPage renders 404 heading and canonical resource navigation links", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConsoleNotFoundPage, { title: "Page not found" })
  );

  assert.match(markup, /404/);
  assert.match(markup, /Page not found/);
  // The page belongs to no section, so it claims none. It used to fall back to
  // Workspaces, which put a section's name in the heading the navigation owner
  // announces and marked that section as the current one in the rail -- the
  // operator was told they were on a page they were not on.
  assert.match(
    markup,
    /<h1[^>]*>Page not found</u,
    "the page's heading names the page, not a section"
  );
  assert.doesNotMatch(
    markup,
    /aria-current="page"/u,
    "no section is the current one on a page that belongs to none"
  );
  assert.match(markup, /data-testid="not-found-page"/);
  assert.match(markup, /href="\/agents"/);
  assert.match(markup, /href="\/providers"/);
  assert.match(markup, /href="\/workspaces"/);
  // The address named no section, so there is nowhere to return to and the
  // link names a destination instead. "Return to Agents" was a claim about
  // where the operator had been, and they had never been there.
  assert.match(markup, /Go to Agents/);
  assert.doesNotMatch(markup, /Return to/u);
});

test("the not-found page returns to the section the address was reaching for", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConsoleNotFoundPage, {
      title: "Page not found",
      section: "Hooks"
    })
  );

  // A stale deep link into a section takes the operator back to that section.
  // The page used to offer Agents, Providers and Workspaces whatever the
  // address said, so the section the operator was actually reaching for was
  // in the address bar and nowhere else.
  assert.match(markup, /Return to Hooks/);
  assert.match(markup, /href="\/hooks"/);

  // And the primary way out is not repeated among the others: one link per
  // destination, so the operator has no choice to make for no reason.
  assert.equal(markup.match(/Return to Hooks/gu)?.length, 1);
});

test("the error boundary claims no section when the failed address named none", () => {
  const mockError = new Error("Render failed") as Error & {
    digest?: string;
  };

  const markup = renderToStaticMarkup(
    React.createElement(ConsoleErrorPage, {
      error: mockError,
      reset: () => {}
    })
  );

  // The boundary used to fall back to Agents, so a failure on an address that
  // named no section was reported on the Agents page: the heading said
  // "Agents" and the rail marked Agents as the current one.
  assert.match(
    markup,
    /<h1[^>]*>Render failure</u,
    "the page's heading names the page, not a section"
  );
  assert.doesNotMatch(
    markup,
    /aria-current="page"/u,
    "no section is the current one on a page that belongs to none"
  );
  assert.match(markup, /Go to Agents/);
  assert.doesNotMatch(markup, /Return to/u);
});

test("the error boundary returns to the section that failed", () => {
  const mockError = new Error("Render failed") as Error & {
    digest?: string;
  };

  const markup = renderToStaticMarkup(
    React.createElement(ConsoleErrorPage, {
      error: mockError,
      reset: () => {},
      activeSection: "Providers"
    })
  );

  // The link's name says where it points at, and the page can keep the
  // promise: the operator was on Providers when it failed.
  assert.match(markup, /Return to Providers/);
  assert.match(markup, /href="\/providers"/);
  assert.match(
    markup,
    /<h1[^>]*>Providers</u,
    "the page's heading names the section that failed"
  );
});

test("ConsoleErrorPage renders alert container with error message and actions", () => {
  let resetCalled = false;
  const mockError = new Error("Telemetry connection timed out") as Error & {
    digest?: string;
  };
  mockError.digest = "d-test-1234";

  const markup = renderToStaticMarkup(
    React.createElement(ConsoleErrorPage, {
      error: mockError,
      reset: () => {
        resetCalled = true;
      },
      activeSection: "Agents"
    })
  );

  assert.match(markup, /role="alert"/);
  assert.match(markup, /Console render failure/);
  assert.match(markup, /Telemetry connection timed out/);
  assert.match(markup, /digest: d-test-1234/);
  assert.match(markup, /Try again/);
  assert.match(markup, /href="\/agents"/);
  assert.match(markup, /Return to Agents/);
  assert.strictEqual(resetCalled, false);
});

test("ConsoleErrorPage renders default message when error message is empty and omits digest when absent", () => {
  const mockError = Object.assign(new Error("Initial error"), {
    message: ""
  }) as Error & { digest?: string };

  const markup = renderToStaticMarkup(
    React.createElement(ConsoleErrorPage, {
      error: mockError,
      reset: () => {},
      activeSection: "Agents"
    })
  );

  assert.match(markup, /role="alert"/);
  assert.match(
    markup,
    /An unexpected error occurred while rendering this page\./
  );
  assert.doesNotMatch(markup, /digest:/);
});

test("the Console route not-found and error boundaries delegate to AppShell shells", () => {
  const notFoundSource = readFileSync(
    new URL("../app/not-found.ts", import.meta.url),
    "utf8"
  );
  assert.match(notFoundSource, /ConsoleNotFoundShell/u);

  const errorSource = readFileSync(
    new URL("../app/error.ts", import.meta.url),
    "utf8"
  );
  assert.match(errorSource, /^"use client";/mu);
  assert.match(errorSource, /ConsoleErrorShell/u);
});
