import assert from "node:assert/strict";
import test from "node:test";

import {
  type ControlApiSkillContentResponse,
  LOCAL_CONTROL_API_ACTOR,
  type ReconciliationView
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SkillDetailView } from "../src/features/skills/SkillDetailView.ts";
import { SkillsView } from "../src/features/skills/SkillsView.ts";
import { fetchSkillContent } from "../src/lib/server/control-api.ts";

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
const RECONCILIATION: ReconciliationView = {
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
const DETAIL_SOURCE: ControlApiSkillContentResponse = {
  schema: "autodev-control-skill-content-v2",
  name: NAME,
  path: PATH,
  content: SOURCE,
  revision: REVISION,
  reconciliation: RECONCILIATION
};

function sourceResponse(overrides: Record<string, unknown> = {}) {
  return {
    schema: "autodev-control-skill-content-v2",
    name: NAME,
    path: PATH,
    content: SOURCE,
    revision: REVISION,
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

test("Skills rows link to the canonical source detail, and the detail is read-only", () => {
  const list = renderToStaticMarkup(
    React.createElement(SkillsView, {
      executionContractObserved: true,
      skills: [
        {
          name: NAME,
          description: "Release steps.",
          path: PATH,
          scope: "user",
          scopeLocation: "/home/operator/.agents/skills/release-checklist",
          workspace: null
        }
      ],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: [],
      executionContractRevision: null,
      telemetry: { observed: false, bySkill: new Map() }
    })
  );
  assert.match(list, new RegExp(`href="/skills/${NAME}"`, "u"));

  const detail = renderToStaticMarkup(
    React.createElement(SkillDetailView, {
      source: DETAIL_SOURCE
    })
  );
  // The canonical source is shown, with the shared Rendered | Source selector
  // over it, and the breadcrumb the operator came in by. The page opens on the
  // rendered reading; the raw text is one click away in the same view.
  assert.match(detail, /aria-label="Breadcrumb"/u);
  assert.match(detail, /aria-label="Source representation"/u);
  assert.match(detail, /Canonical RuleSync source/u);
  assert.match(detail, /data-source-view="rendered"/u);
  assert.match(detail, /data-source-rendered="true"/u);
  assert.match(detail, /Release/u);
  assert.doesNotMatch(detail, /Skill content is active/u);

  // The skill is repository-owned: the detail offers no editor, no revision to
  // write against, and no way to submit a changed source. A change is made in
  // the canonical file and reconciled by the standard workflow.
  assert.doesNotMatch(detail, /<form\b/u);
  assert.doesNotMatch(detail, /name="expectedRevision"/u);
  assert.doesNotMatch(detail, /Save &amp; Apply/u);
  assert.doesNotMatch(detail, /configured RuleSync skill projections/u);
});

test("the skill detail renders the reconciliation the Runtime reported", () => {
  const detail = renderToStaticMarkup(
    React.createElement(SkillDetailView, {
      source: DETAIL_SOURCE
    })
  );
  assert.match(detail, /data-section="skill-reconciliation"/u);
  assert.match(detail, /Converged/u);
  // The generations behind the verdict are the Runtime's, rendered as it
  // reported them rather than derived by the page.
  assert.match(
    detail,
    new RegExp(`data-field="desired-generation">${UPDATED_REVISION}<`, "u")
  );
  assert.match(
    detail,
    new RegExp(`data-field="observed-generation">${UPDATED_REVISION}<`, "u")
  );
  assert.match(detail, /No recorded operations for this resource\./u);
});
