import assert from "node:assert/strict";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConsolePageShell } from "../app/_console.ts";
import {
  ConsoleErrorPage,
  ConsoleLoadingPage,
  ConsoleNotFoundPage
} from "../src/components/layout/AppShell.ts";

test("the page publishes the client's arrival", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      ConsolePageShell,
      { section: "Agents" },
      React.createElement("p", null, "Configured agent roles")
    )
  );

  // One marker. It is a state the page publishes rather than a piece of
  // layout: it carries no text, it is not announced, and it exists so that
  // "the content is here" and "the client is here" are two facts a caller can
  // wait for separately rather than one fact it has to infer.
  assert.equal(markup.match(/data-hydration-marker="true"/gu)?.length, 1);
  assert.match(
    markup,
    /<span(?=[^>]*hidden)(?=[^>]*data-hydration-marker="true")[^>]*>/u
  );

  // And it is the last thing in the page. Everything the content is made of
  // is mounted before it, so a caller that waits for the marker is waiting
  // for the page's own controls to be live and not merely for the shell
  // around them.
  assert.ok(
    markup.indexOf("Configured agent roles") <
      markup.indexOf('data-hydration-marker="true"'),
    "the marker is rendered after the page's own content"
  );
});

test("the pending state does not publish the client's arrival", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConsoleLoadingPage, { activeSection: "Agents" })
  );

  // The pending state stands in for a page that has not arrived, so it must
  // not report that the client has taken the page over. A marker it set
  // would say the page is interactive while the page is still on its way.
  assert.doesNotMatch(markup, /data-hydration-marker/u);
});

test("both failure pages publish the client's arrival", () => {
  const mockError = new Error("Render failed") as Error & {
    digest?: string;
  };

  const notFound = renderToStaticMarkup(
    React.createElement(ConsoleNotFoundPage, { title: "Page not found" })
  );
  const failed = renderToStaticMarkup(
    React.createElement(ConsoleErrorPage, {
      error: mockError,
      reset: () => {}
    })
  );

  // Every other page publishes the marker, and these two are pages too: ten
  // detail routes answer with the not-found page when their resource is
  // absent, so a caller that waits for the client the way it waits on every
  // other page would wait forever on the page that says the address was wrong.
  const pages: readonly { readonly markup: string; readonly anchor: string }[] =
    [
      {
        markup: notFound,
        anchor: 'data-testid="not-found-page"'
      },
      {
        markup: failed,
        anchor: 'data-testid="console-error-boundary"'
      }
    ];
  for (const page of pages) {
    assert.equal(
      page.markup.match(/data-hydration-marker="true"/gu)?.length,
      1
    );
    assert.match(
      page.markup,
      /<span(?=[^>]*hidden)(?=[^>]*data-hydration-marker="true")[^>]*>/u
    );
    // And it is the last thing in the page's content, so a caller that waits
    // for it is waiting for the page's own controls -- the "Try again" button
    // on the failure page -- and not merely for the shell around them.
    assert.ok(
      page.markup.indexOf('data-hydration-marker="true"') >
        page.markup.indexOf(page.anchor),
      "the marker is rendered after the page's own content"
    );
  }
});
