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
    React.createElement(ConsoleNotFoundPage, { activeSection: "Workspaces" })
  );

  assert.match(markup, /404/);
  assert.match(markup, /Page not found/);
  assert.match(markup, /data-testid="not-found-page"/);
  assert.match(markup, /href="\/agents"/);
  assert.match(markup, /href="\/providers"/);
  assert.match(markup, /href="\/workspaces"/);
  assert.match(markup, /Return to Agents/);
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
