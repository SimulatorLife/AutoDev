import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_PERMISSIONS_SCHEMA_ID,
  controlApiPermissionsResponseSchema
} from "../src/control-api/permissions.ts";

function permissionsResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: CONTROL_API_PERMISSIONS_SCHEMA_ID,
    source: ".rulesync/permissions.jsonc",
    readOnly: true,
    executionContractObserved: true,
    revision: "a".repeat(64),
    sourceText: "{}",
    policy: {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      webSearch: true
    },
    policyStatus: "valid",
    policyReason: null,
    applied: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      webSearch: false
    },
    appliedSource: "/home/.codex/config.toml",
    rolePermissions: {
      coder: {
        readOnly: false,
        mcp: ["lsp"],
        mcpTools: { lsp: ["goto_definition"] },
        skills: ["dry"]
      }
    },
    ...overrides
  };
}

test("permissions contract accepts valid and unavailable states and refuses invalid policies", () => {
  assert.equal(
    controlApiPermissionsResponseSchema.safeParse(permissionsResponse()).success,
    true
  );
  assert.equal(
    controlApiPermissionsResponseSchema.safeParse(
      permissionsResponse({
        policy: null,
        policyStatus: "unavailable",
        policyReason: "Missing file",
        applied: null
      })
    ).success,
    true
  );
  assert.equal(
    controlApiPermissionsResponseSchema.safeParse(
      permissionsResponse({ readOnly: false })
    ).success,
    false
  );
  assert.equal(
    controlApiPermissionsResponseSchema.safeParse(
      permissionsResponse({
        policy: {
          approvalPolicy: "always",
          approvalsReviewer: "user",
          webSearch: true
        }
      })
    ).success,
    false
  );
});
