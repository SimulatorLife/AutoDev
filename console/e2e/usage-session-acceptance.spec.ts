import { expect, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers";

const SESSION_ID = "01a0ba14-d54c-78f2-9367-3f80e9a8f75f";

const SESSION_EVIDENCE = {
  partial: false,
  spans: [
    {
      spanId: "0123456789abcdef",
      traceId: "0123456789abcdef0123456789abcdef",
      parentSpanId: null,
      operationName: "chat",
      timestamp: "2026-11-10T12:00:00.000Z",
      durationNs: 1_000_000,
      statusCode: "OK",
      provider: "claude",
      requestedModel: "autodev/worker",
      role: "worker",
      workspace: "SimulatorLife/AutoDev",
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 4,
      costUsd: 0.001,
      requestKind: null,
      compactionProvider: null,
      hopRoute: null,
      hopFrom: null,
      hopTo: null,
      hopReason: null
    },
    {
      spanId: "1123456789abcdef",
      traceId: "1123456789abcdef0123456789abcdef",
      parentSpanId: null,
      operationName: "autodev.routed_request",
      timestamp: "2026-11-10T11:59:00.000Z",
      durationNs: 2_000_000,
      statusCode: "OK",
      provider: null,
      requestedModel: "autodev/orchestrator",
      role: "orchestrator",
      workspace: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      costUsd: null,
      requestKind: "compaction",
      compactionProvider: "codex",
      hopRoute: "claude → codex",
      hopFrom: "claude",
      hopTo: "codex",
      hopReason: "fallback"
    }
  ]
};

test("exact-session Usage investigation keeps the ID in a same-origin POST body", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let body: unknown = null;
  await page.route("**/api/usage/session", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.url()).not.toContain(SESSION_ID);
    body = request.postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schema: "autodev-console-session-usage-v1",
        kind: "ok",
        data: SESSION_EVIDENCE
      })
    });
  });
  await page.goto("/usage");
  await waitForPageContent(page);

  const panel = page.locator('[data-feature="usage-session-lookup"]');
  await panel.getByLabel("Session ID").fill(SESSION_ID);
  await panel.getByRole("button", { name: "Inspect session" }).click();

  await expect(panel).toHaveAttribute("data-session-lookup-state", "observed");
  const sessionRegion = panel.getByRole("region", {
    name: "Session activity spans"
  });
  const sessionTable = sessionRegion.locator("table");
  await expect(sessionRegion).toBeVisible();
  await expect(sessionTable).toContainText("autodev/worker");
  await expect(sessionTable).toContainText("worker");
  await expect(sessionTable).toContainText("Compaction served by codex");
  await expect(sessionTable).toContainText(
    "Provider hop claude → codex (fallback)"
  );
  await expect(sessionTable).toContainText("Not attributed");
  expect(body).toEqual({
    sessionId: SESSION_ID,
    selection: { range: "24H" }
  });
  await expect(page).not.toHaveURL(new RegExp(SESSION_ID));
  await expect(sessionTable.getByText(SESSION_ID, { exact: true })).toHaveCount(
    0
  );
});

test("exact-session Usage investigation distinguishes empty and partial reads", async ({
  page
}) => {
  await page.route("**/api/usage/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schema: "autodev-console-session-usage-v1",
        kind: "ok",
        data: { partial: true, spans: [] }
      })
    });
  });
  await page.goto("/usage");
  await waitForPageContent(page);

  const panel = page.locator('[data-feature="usage-session-lookup"]');
  await panel.getByLabel("Session ID").fill(SESSION_ID);
  await panel.getByRole("button", { name: "Inspect session" }).click();
  await expect(panel).toContainText(
    "No source-confirmed spans were observed for this session"
  );
  await expect(panel).toContainText("This session result is partial");
});

test("malformed session summaries fail closed instead of reaching the table", async ({
  page
}) => {
  await page.route("**/api/usage/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schema: "autodev-console-session-usage-v1",
        kind: "ok",
        data: {
          partial: false,
          spans: [{ spanId: "0123456789abcdef", sessionId: SESSION_ID }]
        }
      })
    });
  });
  await page.goto("/usage");
  await waitForPageContent(page);

  const panel = page.locator('[data-feature="usage-session-lookup"]');
  await panel.getByLabel("Session ID").fill(SESSION_ID);
  await panel.getByRole("button", { name: "Inspect session" }).click();
  await expect(panel).toHaveAttribute(
    "data-session-lookup-state",
    "invalid-response"
  );
  await expect(panel).toContainText(
    "The session telemetry response was invalid."
  );
  await expect(
    panel.getByRole("region", { name: "Session activity spans" })
  ).toHaveCount(0);
});

test("invalid session IDs are rejected before the session endpoint is called", async ({
  page
}) => {
  let requests = 0;
  await page.route("**/api/usage/session", async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schema: "autodev-console-session-usage-v1",
        kind: "ok",
        data: SESSION_EVIDENCE
      })
    });
  });
  await page.goto("/usage");
  await waitForPageContent(page);

  const panel = page.locator('[data-feature="usage-session-lookup"]');
  await panel.getByLabel("Session ID").fill("process-fallback");
  await panel.getByRole("button", { name: "Inspect session" }).click();
  await expect(panel).toContainText(
    "Enter a valid source-confirmed session ID"
  );
  expect(requests).toBe(0);
});
