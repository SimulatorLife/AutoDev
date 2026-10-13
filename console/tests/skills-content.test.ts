import assert from "node:assert/strict";
import test from "node:test";

import {
  type ControlApiSkillContentResponse,
  LOCAL_CONTROL_API_ACTOR
} from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST as skillContentMutation } from "../app/api/skills/[name]/content/route.ts";
import { SkillDetailView } from "../src/features/skills/SkillDetailView.ts";
import { SkillsView } from "../src/features/skills/SkillsView.ts";
import {
  fetchSkillContent,
  patchSkillContent
} from "../src/lib/server/control-api.ts";

const CONFIG = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "server-only-skill-token"
};
const NAME = "release-checklist";
const PATH = `.rulesync/skills/${NAME}/SKILL.md`;
const REVISION = "a".repeat(64);
const UPDATED_REVISION = "b".repeat(64);
const SOURCE =
  "---\nname: release-checklist\ndescription: Release steps.\n---\n\n# Release\n";
const DETAIL_SOURCE: ControlApiSkillContentResponse = {
  schema: "autodev-control-skill-content-v1",
  name: NAME,
  path: PATH,
  content: SOURCE,
  revision: REVISION
};
const RECONCILIATION = {
  status: {
    convergence: "converged",
    desiredGeneration: UPDATED_REVISION,
    observedGeneration: UPDATED_REVISION,
    lastApplyAt: "2026-10-13T12:00:00.000Z",
    lastObservationAt: "2026-10-13T12:00:00.000Z",
    lastError: null,
    explanation: "Canonical skill projections are current."
  },
  history: []
};

function sourceResponse(overrides: Record<string, unknown> = {}) {
  return {
    schema: "autodev-control-skill-content-v1",
    name: NAME,
    path: PATH,
    content: SOURCE,
    revision: REVISION,
    ...overrides
  };
}

function patchResponse(overrides: Record<string, unknown> = {}) {
  return {
    schema: "autodev-control-skill-content-patch-v1",
    name: NAME,
    revision: UPDATED_REVISION,
    changed: true,
    projectionApplied: true,
    reconciliation: RECONCILIATION,
    ...overrides
  };
}

test("skill source fetcher uses the typed server route and rejects mismatched identities", async () => {
  const requests: Array<{
    url: string;
    method: string | undefined;
    headers: Headers;
  }> = [];
  const result = await fetchSkillContent(NAME, CONFIG, {
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers)
      });
      return Response.json(sourceResponse());
    }
  });
  assert.equal(result.kind, "ok");
  assert.deepEqual(
    requests.map(({ url, method }) => ({ url, method })),
    [
      {
        url: `http://127.0.0.1:4101/control/skills/${NAME}/content`,
        method: "GET"
      }
    ]
  );
  assert.equal(
    requests[0]?.headers.get("authorization"),
    "Bearer server-only-skill-token"
  );
  assert.equal(
    requests[0]?.headers.get("x-autodev-actor"),
    LOCAL_CONTROL_API_ACTOR
  );

  const mismatched = await fetchSkillContent(NAME, CONFIG, {
    fetchImpl: async () =>
      Response.json(sourceResponse({ name: "other-skill" }))
  });
  assert.equal(mismatched.kind, "invalid-response");
  if (mismatched.kind === "invalid-response") {
    assert.equal(
      mismatched.code,
      "autodev_control_api_invalid_skill_content_response"
    );
  }
});

test("skill content mutation uses the source subresource and requires a confirmed projection response", async () => {
  const requests: Array<{
    url: string;
    method: string | undefined;
    body: unknown;
  }> = [];
  const result = await patchSkillContent(
    NAME,
    { expectedRevision: REVISION, content: SOURCE },
    CONFIG,
    {
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          body: JSON.parse(String(init?.body))
        });
        return Response.json(patchResponse());
      }
    }
  );
  assert.equal(result.kind, "ok");
  assert.deepEqual(requests, [
    {
      url: `http://127.0.0.1:4101/control/skills/${NAME}/content`,
      method: "PATCH",
      body: { expectedRevision: REVISION, content: SOURCE }
    }
  ]);

  const unconfirmed = await patchSkillContent(
    NAME,
    { expectedRevision: REVISION, content: SOURCE },
    CONFIG,
    {
      fetchImpl: async () =>
        Response.json(patchResponse({ projectionApplied: false }))
    }
  );
  assert.equal(unconfirmed.kind, "invalid-response");
});

test("Skills rows link to one canonical source editor and editor posts the exact revision and source", () => {
  const list = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [{ name: NAME, description: "Release steps.", path: PATH }],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: [],
      executionContractRevision: null
    })
  );
  assert.match(list, new RegExp(`href="/skills/${NAME}"`, "u"));

  const detail = renderToStaticMarkup(
    React.createElement(SkillDetailView, {
      source: DETAIL_SOURCE
    })
  );
  assert.match(detail, /aria-label="Edit canonical skill release-checklist"/u);
  assert.match(detail, new RegExp(`action="/api/skills/${NAME}/content"`, "u"));
  assert.match(
    detail,
    new RegExp(`name="expectedRevision" value="${REVISION}"`, "u")
  );
  assert.match(detail, /name="content"[^>]*Complete SKILL\.md source/u);
  assert.match(detail, /Save &amp; Apply/u);
  assert.match(detail, /configured RuleSync skill projections/u);
  assert.match(detail, /aria-label="Breadcrumb"/u);
  assert.doesNotMatch(detail, /Skill content is active/u);
});

test("same-origin skill editor form keeps the Runtime credential server-side and redirects to confirmed source", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBaseUrl = process.env.AUTODEV_CONTROL_API_BASE_URL;
  const requests: Array<{
    url: string;
    method: string | undefined;
    headers: Headers;
    body: string;
  }> = [];
  process.env.AUTODEV_CONTROL_API_TOKEN = "server-only-skill-token";
  process.env.AUTODEV_CONTROL_API_BASE_URL = CONFIG.baseUrl;
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: String(init?.body ?? "")
    });
    return Response.json(patchResponse());
  };

  const makeRequest = (): NextRequest =>
    new NextRequest(`http://console.test/api/skills/${NAME}/content`, {
      method: "POST",
      headers: {
        origin: "http://console.test",
        host: "console.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        expectedRevision: REVISION,
        content: SOURCE
      }).toString()
    });

  try {
    const response = await skillContentMutation(makeRequest(), {
      params: Promise.resolve({ name: NAME })
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/skills/${NAME}`);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.url,
      `${CONFIG.baseUrl}/control/skills/${NAME}/content`
    );
    assert.equal(requests[0]?.method, "PATCH");
    assert.equal(
      requests[0]?.headers.get("authorization"),
      "Bearer server-only-skill-token"
    );
    assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
      expectedRevision: REVISION,
      content: SOURCE
    });
    assert.equal(
      response.headers.get("location")?.includes("server-only-skill-token"),
      false
    );

    globalThis.fetch = async () =>
      Response.json(
        {
          error: {
            code: "autodev_control_skill_apply_failed",
            message: "Canonical source changed, but projection apply failed."
          }
        },
        { status: 503 }
      );
    const failed = await skillContentMutation(makeRequest(), {
      params: Promise.resolve({ name: NAME })
    });
    assert.equal(failed.status, 303);
    assert.equal(
      failed.headers.get("location"),
      `/skills/${NAME}?save=apply-failed`
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousBaseUrl === undefined)
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    else process.env.AUTODEV_CONTROL_API_BASE_URL = previousBaseUrl;
  }
});

test("skill source form rejects cross-origin, duplicate, and malformed submissions", async () => {
  const request = (headers: Record<string, string>, body: string) =>
    new NextRequest(`http://console.test/api/skills/${NAME}/content`, {
      method: "POST",
      headers,
      body
    });
  const headers = {
    origin: "http://console.test",
    host: "console.test",
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded"
  };

  const crossOrigin = await skillContentMutation(
    request({ ...headers, origin: "http://evil.test" }, ""),
    { params: Promise.resolve({ name: NAME }) }
  );
  assert.equal(
    crossOrigin.headers.get("location"),
    `/skills/${NAME}?save=failed`
  );

  const duplicate = await skillContentMutation(
    request(
      headers,
      new URLSearchParams([
        ["expectedRevision", REVISION],
        ["content", SOURCE],
        ["content", SOURCE]
      ]).toString()
    ),
    { params: Promise.resolve({ name: NAME }) }
  );
  assert.equal(
    duplicate.headers.get("location"),
    `/skills/${NAME}?save=failed`
  );
});
