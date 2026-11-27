import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PermissionsView } from "../src/features/permissions/index.ts";

/** Read-only permission-policy presentation and effective role evidence. */

const REVISION = "a".repeat(64);

const POLICY = {
  approvalPolicy: "never" as const,
  approvalsReviewer: "user",
  webSearch: true
};

function markup(
  overrides: {
    readonly policy?: typeof POLICY | null;
    readonly revision?: string | null;
    readonly policyStatus?: "valid" | "invalid" | "unavailable";
    readonly roleMatrices?: readonly {
      readonly role: string;
      readonly readOnly: boolean;
      readonly allowedMcpServers: readonly string[];
      readonly allowedSkills: readonly string[];
      readonly allowedMcpTools: Readonly<Record<string, readonly string[]>>;
    }[];
    readonly executionContractObserved?: boolean;
  } = {}
): string {
  return renderToStaticMarkup(
    React.createElement(PermissionsView, {
      policy: overrides.policy === undefined ? POLICY : overrides.policy,
      policyStatus: overrides.policyStatus ?? "valid",
      policyReason:
        overrides.policyStatus === undefined ||
        overrides.policyStatus === "valid"
          ? null
          : "The canonical permission policy could not be read.",
      revision:
        overrides.revision === undefined ? REVISION : overrides.revision,
      applied: null,
      appliedSource: "/tmp/codex/config.toml",
      executionContractObserved: overrides.executionContractObserved ?? true,
      roleMatrices: overrides.roleMatrices ?? [
        {
          role: "orchestrator",
          readOnly: false,
          allowedMcpServers: ["lsp"],
          allowedSkills: [],
          allowedMcpTools: {}
        }
      ],
      sourceText: null
    })
  );
}

test("the policy renders repository values without a mutation control", () => {
  const rendered = markup();
  assert.match(rendered, />never</u);
  assert.match(rendered, />user</u);
  assert.match(rendered, />Enabled</u);
  assert.doesNotMatch(
    rendered,
    /<form|<select|<textarea|name="expectedRevision"|action="\/api\/permissions"/u
  );
});

test("an unreadable policy is not a fabricated default or disabled editor", () => {
  const rendered = markup({
    policy: null,
    revision: null,
    policyStatus: "unavailable"
  });
  assert.match(
    rendered,
    /The canonical permission policy could not be read\./u
  );
  assert.match(rendered, /Not observed/u);
  assert.doesNotMatch(rendered, /<form|<select|<textarea|>never</u);
});

test("a role's access level is rendered from its readOnly flag", () => {
  const readOnlyMarkup = markup({
    roleMatrices: [
      {
        role: "explorer",
        readOnly: true,
        allowedMcpServers: [],
        allowedSkills: [],
        allowedMcpTools: {}
      }
    ]
  });
  assert.match(readOnlyMarkup, /data-permission-access="read-only"/u);
  assert.match(readOnlyMarkup, /Read-only/u);

  const readWriteMarkup = markup();
  assert.match(readWriteMarkup, /data-permission-access="read-write"/u);
  assert.match(readWriteMarkup, /Read \/ Write/u);
});

test("the applied state is shown beside the canonical source", () => {
  const rendered = markup();
  assert.match(rendered, /Applied State/u);
  // Nothing has been observed of the composed configuration, so the page says
  // so rather than reporting a converged policy.
  assert.match(rendered, /Pending/u);
  assert.match(rendered, /Canonical Source/u);
});

test("the Permissions page reaches the feature through its entrypoint", () => {
  const callers = [new URL("../app/permissions/page.tsx", import.meta.url)];
  for (const caller of callers) {
    const source = readFileSync(caller, "utf8");
    assert.match(
      source,
      /from\s+["'][^"']*src\/features\/permissions\/index\.ts["']/u,
      caller.pathname + " must import Permissions through its entrypoint"
    );
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*src\/features\/permissions\/(?!index\.ts)["']/u,
      caller.pathname +
        " must not reach past the entrypoint into Permissions modules"
    );
  }
});
