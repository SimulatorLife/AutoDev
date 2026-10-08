import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import UsagePage from "../app/usage/page.ts";

const usageToken = "usage-page-test-token";
const traceSpanId = "0123456789abcdef";
const usageResponse = {
  schema: "autodev-openlit-usage-v3",
  widgets: [],
  filterOptions: {
    workspace: { supported: true, values: [] },
    provider: { supported: true, values: ["openai"] },
    model: { supported: true, values: [] },
    agent: { supported: true, values: [] },
    skill: { supported: true, values: [] }
  },
  traceList: {
    kind: "observed",
    partial: false,
    attempts: [
      {
        spanId: traceSpanId,
        timestamp: "2026-10-07T12:00:00.000Z",
        durationNs: 1_250_000,
        statusCode: "OK",
        provider: "openai",
        model: "gpt-6-luna",
        role: "orchestrator"
      }
    ]
  }
};
const traceResponse = {
  schema: "autodev-openlit-trace-detail-v1",
  traceId: "0123456789abcdef0123456789abcdef",
  selectedSpanId: traceSpanId,
  partial: false,
  spans: [
    {
      spanId: traceSpanId,
      parentSpanId: null,
      spanName: "gen_ai.client_operation",
      serviceName: "autodev-router",
      timestamp: "2026-10-07T12:00:00.000Z",
      durationNs: 1_250_000,
      statusCode: "OK"
    }
  ]
};

function withUsageConfig(): () => void {
  const oldToken = process.env.AUTODEV_OPENLIT_USAGE_TOKEN;
  const oldUrl = process.env.AUTODEV_OPENLIT_USAGE_URL;
  const oldFetch = globalThis.fetch;
  process.env.AUTODEV_OPENLIT_USAGE_TOKEN = usageToken;
  process.env.AUTODEV_OPENLIT_USAGE_URL = "http://openlit.test";
  return () => {
    if (oldToken === undefined) delete process.env.AUTODEV_OPENLIT_USAGE_TOKEN;
    else process.env.AUTODEV_OPENLIT_USAGE_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.AUTODEV_OPENLIT_USAGE_URL;
    else process.env.AUTODEV_OPENLIT_USAGE_URL = oldUrl;
    globalThis.fetch = oldFetch;
  };
}

test("UsagePage renders validated v3 metrics and selected trace using server-side OpenLIT calls", async () => {
  const restore = withUsageConfig();
  try {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "http://openlit.test/api/autodev/usage") {
        return Response.json(usageResponse);
      }
      if (url === `http://openlit.test/api/autodev/usage/span/${traceSpanId}`) {
        return Response.json(traceResponse);
      }
      throw new Error(`Unexpected Usage request: ${url}`);
    };

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({
          range: "7D",
          provider: "openai",
          spanId: traceSpanId
        })
      })
    );

    assert.deepEqual(
      requests.map(({ url }) => url),
      [
        "http://openlit.test/api/autodev/usage",
        `http://openlit.test/api/autodev/usage/span/${traceSpanId}`
      ]
    );
    for (const request of requests) {
      assert.equal(
        (request.init?.headers as Record<string, string>).Authorization,
        `Bearer ${usageToken}`
      );
    }
    assert.match(markup, /Recent provider attempts/);
    assert.match(markup, /data-feature="usage-trace-detail"/);
    assert.match(markup, /gen_ai\.client_operation/);
    assert.match(markup, /value="openai" selected/);
    assert.doesNotMatch(markup, new RegExp(usageToken));
  } finally {
    restore();
  }
});

test("UsagePage fails closed on a stale response schema while retaining its filters", async () => {
  const restore = withUsageConfig();
  try {
    globalThis.fetch = async () =>
      Response.json({ ...usageResponse, schema: "autodev-openlit-usage-v2" });

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({ range: "7D", provider: "openai" })
      })
    );

    assert.match(markup, /Usage telemetry response was invalid/);
    assert.match(markup, /data-usage-observed="false"/);
    assert.match(markup, /Selected: openai/);
    assert.match(markup, /name="provider" value="openai"/);
    assert.doesNotMatch(markup, /Requests &amp; model usage/);
  } finally {
    restore();
  }
});

test("UsagePage maps an unreachable OpenLIT source to the actionable unavailable state", async () => {
  const restore = withUsageConfig();
  try {
    globalThis.fetch = async () => {
      throw new TypeError("connection refused");
    };

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({ range: "24H", provider: "openai" })
      })
    );

    assert.match(markup, /autodev_openlit_usage_unreachable/);
    assert.match(markup, /Check that OpenLIT is running/);
    assert.match(markup, /Selected: openai/);
    assert.match(markup, /data-usage-observed="false"/);
    assert.doesNotMatch(markup, /Requests &amp; model usage/);
  } finally {
    restore();
  }
});
