import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type PermissionPolicySaveOutcome,
  permissionPolicySaveOutcomeFromQuery,
  PermissionsView
} from "../src/features/permissions/index.ts";

/**
 * The one control that writes the canonical permission policy.
 *
 * The policy is one surface, and these cases pin what it says: which route it
 * writes to, which revision it decides the write on, what it does when the
 * canonical source could not be read, and what it says about a role whose
 * sandbox was not observed.
 */

const REVISION = "a".repeat(64);
const ACTION = "/api/permissions";

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
    readonly saveOutcome?: PermissionPolicySaveOutcome;
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
      ...(overrides.saveOutcome === undefined
        ? {}
        : { saveOutcome: overrides.saveOutcome })
    })
  );
}

test("the control writes the policy through the same-origin route", () => {
  const rendered = markup();
  assert.match(rendered, new RegExp(`action="${ACTION}"`, "u"));
  assert.match(rendered, /method="POST"/u);
  // The write is decided on the revision the page was rendered with.
  assert.match(rendered, new RegExp(`value="${REVISION}"`, "u"));
  assert.match(rendered, /name="approvalPolicy"/u);
  assert.match(rendered, /name="approvalsReviewer"/u);
  assert.match(rendered, /name="webSearch"/u);
  assert.doesNotMatch(rendered, /name="sandboxMode"/u);
  assert.doesNotMatch(rendered, /name="networkAccess"/u);
  // A select commits on change, so the policy has no second Apply control.
  assert.doesNotMatch(rendered, /type="submit"/u);
});

test("a policy that could not be read leaves the control in place, disabled, with the reason", () => {
  const rendered = markup({
    policy: null,
    revision: null,
    policyStatus: "unavailable"
  });
  assert.match(rendered, /action="\/api\/permissions"/u);
  assert.match(rendered, /disabled/u);
  assert.match(
    rendered,
    /The canonical permission policy could not be read, so there is nothing to write\./u
  );
  // An unreadable policy is not a policy of defaults, so the page does not
  // answer with one.
  assert.doesNotMatch(rendered, /value="never"/u);
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

test("the view renders the save outcome notice from the query value", () => {
  assert.equal(permissionPolicySaveOutcomeFromQuery("conflict"), "conflict");
  assert.equal(permissionPolicySaveOutcomeFromQuery(["failed"]), "failed");
  assert.equal(permissionPolicySaveOutcomeFromQuery("unknown"), undefined);
  const conflict = markup({ saveOutcome: "conflict" });
  assert.match(conflict, /data-permission-policy-save="conflict"/u);
  assert.match(conflict, /role="status"/u);
  const failed = markup({ saveOutcome: "failed" });
  assert.match(failed, /data-permission-policy-save="failed"/u);
  assert.match(failed, /role="alert"/u);
});

test("the Permissions page and route reach the feature through its entrypoint", () => {
  const callers = [
    new URL("../app/permissions/page.tsx", import.meta.url),
    new URL("../app/api/permissions/route.ts", import.meta.url)
  ];
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
