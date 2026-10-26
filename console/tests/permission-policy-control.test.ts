import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PermissionsView } from "../src/features/permissions/PermissionsView.ts";

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
  sandboxMode: "workspace-write" as const,
  approvalsReviewer: "user",
  networkAccess: true,
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
      readonly sandboxMode:
        "read-only" | "workspace-write" | "unrestricted" | null;
      readonly allowedMcpServers: readonly string[];
      readonly allowedSkills: readonly string[];
      readonly allowedMcpTools: Readonly<Record<string, readonly string[]>>;
    }[];
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
      roleMatrices: overrides.roleMatrices ?? [
        {
          role: "orchestrator",
          readOnly: false,
          sandboxMode: "unrestricted",
          allowedMcpServers: ["lsp"],
          allowedSkills: [],
          allowedMcpTools: {}
        }
      ],
      returnTo: "/permissions"
    })
  );
}

test("the control writes the policy through the same-origin route", () => {
  const rendered = markup();
  assert.match(rendered, new RegExp(`action="${ACTION}"`, "u"));
  assert.match(rendered, /method="POST"/u);
  // The write is decided on the revision the page was rendered with.
  assert.match(rendered, new RegExp(`value="${REVISION}"`, "u"));
  // Every setting of the policy is a control, and each one carries the
  // product's own vocabulary rather than the canonical source's.
  assert.match(rendered, /name="approvalPolicy"/u);
  assert.match(rendered, /name="sandboxMode"/u);
  assert.match(rendered, /name="approvalsReviewer"/u);
  assert.match(rendered, /name="networkAccess"/u);
  assert.match(rendered, /name="webSearch"/u);
  assert.match(rendered, /value="unrestricted"/u);
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

test("a role whose sandbox was not observed is shown as not observed", () => {
  const rendered = markup({
    roleMatrices: [
      {
        role: "mystery",
        readOnly: false,
        sandboxMode: null,
        allowedMcpServers: [],
        allowedSkills: [],
        allowedMcpTools: {}
      }
    ]
  });
  // The column used to answer every mode but the read-only one with
  // "Unrestricted", so a role whose declaration could not be read was shown as
  // the product's most privileged sandbox.
  assert.match(rendered, /Not observed/u);
  assert.match(rendered, /data-permission-mode="not-observed"/u);
});

test("a role's sandbox is the mode its own declaration states", () => {
  const rendered = markup();
  assert.match(rendered, /data-permission-mode="unrestricted"/u);
  assert.match(rendered, /Unrestricted/u);
});

test("the applied state is shown beside the canonical source", () => {
  const rendered = markup();
  assert.match(rendered, /Applied State/u);
  // Nothing has been observed of the composed configuration, so the page says
  // so rather than reporting a converged policy.
  assert.match(rendered, /Pending/u);
  assert.match(rendered, /Canonical Source/u);
});
