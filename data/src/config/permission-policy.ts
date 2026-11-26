import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync
} from "node:fs";
import path from "node:path";

import {
  type ApprovalPolicy,
  isApprovalPolicy,
  isRecord,
  type PermissionPolicy
} from "@simulatorlife/autodev-core";
import {
  parse as parseJsonc,
  type ParseError,
  printParseErrorCode
} from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

/**
The permission policy's one owner.

The permission policy of a Codex session is declared in `.rulesync/permissions.jsonc`
under `codexcli` (`approval_policy`, `approvals_reviewer`, `tools.web_search`),
and applied into `$CODEX_HOME/config.toml` via RuleSync + `compose-user-config`.

It is read, never written: the declaration is edited in the repository and the
policy is applied from it, so a process that could rewrite the policy could
rewrite the authority that constrains it.
*/

const POLICY_KEYS = {
  approvalPolicy: ["codexcli", "approval_policy"],
  approvalsReviewer: ["codexcli", "approvals_reviewer"],
  webSearch: ["codexcli", "tools", "web_search"]
} as const satisfies Record<string, readonly string[]>;

export type PermissionPolicyKey = keyof typeof POLICY_KEYS;

const POLICY_MAX_BYTES = 1_000_000;

/**
What a read of a policy source found.
*/
export type PermissionPolicyRead =
  | {
      readonly status: "valid";
      readonly policy: PermissionPolicy;
      /**
      The sha256 of the file's exact UTF-8 bytes.
      */
      readonly revision: string;
    }
  | {
      readonly status: "invalid";
      readonly reason: string;
      readonly revision: string | null;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
      readonly revision: null;
    };

/**
The canonical policy source and the policy it states.

The source travels with the policy it was parsed from, so the text an
operator inspects and the values the page renders are one read rather than
two that can straddle a change.
*/
export interface PermissionPolicySource {
  readonly read: PermissionPolicyRead;
  /**
   * The canonical source's exact text, or null when its text could not be
   * read.
   *
   * A source that was read and did not parse still has its text, so the
   * fault can be seen where it is rather than described from outside. A
   * source that was never read has none.
   */
  readonly content: string | null;
}

export function permissionPolicyRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function permissionPolicyGeneration(policy: PermissionPolicy): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        policy.approvalPolicy,
        policy.approvalsReviewer,
        policy.webSearch
      ]),
      "utf8"
    )
    .digest("hex");
}

export function approvalPolicyFromConfig(
  value: unknown
): ApprovalPolicy | null {
  return isApprovalPolicy(value) ? value : null;
}

function emptyPolicy(): PermissionPolicy {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "",
    webSearch: false
  };
}

function policyFromCodexSection(section: Record<string, unknown>): {
  readonly policy: PermissionPolicy;
  readonly reason?: string;
} {
  const approvalPolicy = approvalPolicyFromConfig(section.approval_policy);
  if (approvalPolicy === null) {
    return {
      policy: emptyPolicy(),
      reason: "codexcli.approval_policy must be one of never or on-request"
    };
  }
  const approvalsReviewer = section.approvals_reviewer;
  if (
    typeof approvalsReviewer !== "string" ||
    approvalsReviewer.trim() === ""
  ) {
    return {
      policy: emptyPolicy(),
      reason: "codexcli.approvals_reviewer must be a non-empty string"
    };
  }
  const tools = section.tools;
  if (!isRecord(tools) || typeof tools.web_search !== "boolean") {
    return {
      policy: emptyPolicy(),
      reason: "codexcli.tools.web_search must be a boolean"
    };
  }
  return {
    policy: {
      approvalPolicy,
      approvalsReviewer,
      webSearch: tools.web_search
    }
  };
}

function parseJsoncObject(content: string): {
  readonly value: Record<string, unknown> | null;
  readonly reason?: string;
} {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(content, errors, {
    allowTrailingComma: true
  });
  if (errors.length > 0) {
    const first = errors[0]!;
    return {
      value: null,
      reason: `The permission policy is not valid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    };
  }
  if (!isRecord(parsed)) {
    return {
      value: null,
      reason: "The permission policy must be a JSONC object."
    };
  }
  return { value: parsed };
}

type PolicyFileRead =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly result: Exclude<PermissionPolicyRead, { status: "valid" }>;
    };

function unavailablePolicy(reason: string): PolicyFileRead {
  return { ok: false, result: { status: "unavailable", reason, revision: null } };
}

function invalidPolicy(reason: string): PolicyFileRead {
  return { ok: false, result: { status: "invalid", reason, revision: null } };
}

function oversizedPolicy(): PolicyFileRead {
  return invalidPolicy(
    "The permission policy exceeds its safe size bound and was not read."
  );
}

/**
 * Read a bounded snapshot from one regular-file descriptor. The canonical
 * source's immediate directory and the file itself must not be symlinks.
 * A configured applied-state directory may be an operator-selected alias;
 * the composed file itself must still be regular and not a symlink.
 */
function readRegularPolicyFile(file: string, canonical = true): PolicyFileRead {
  try {
    if (canonical && !lstatSync(path.dirname(file)).isDirectory()) {
      return unavailablePolicy(
        "The canonical permission policy directory is not a regular directory."
      );
    }
    const descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile()) {
        return unavailablePolicy("The permission policy is not a regular file.");
      }
      if (before.size > BigInt(POLICY_MAX_BYTES)) return oversizedPolicy();

      // Read at most the observed size plus one byte, including when a file
      // grows after fstat. Never allocate or hash the oversized source.
      const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = readSync(
          descriptor,
          buffer,
          bytes,
          buffer.length - bytes,
          null
        );
        if (count === 0) break;
        bytes += count;
      }
      if (bytes > POLICY_MAX_BYTES) return oversizedPolicy();

      const after = fstatSync(descriptor, { bigint: true });
      if (
        BigInt(bytes) !== before.size ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      ) {
        return unavailablePolicy("The permission policy changed during the read.");
      }

      try {
        // Reject malformed bytes instead of hashing a replacement-character
        // rendering. Preserve a BOM if present so revisions identify bytes.
        const content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true
        }).decode(buffer.subarray(0, bytes));
        return { ok: true, content };
      } catch {
        return invalidPolicy("The permission policy is not valid UTF-8.");
      }
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? ` (${String((error as NodeJS.ErrnoException).code)})`
        : "";
    return unavailablePolicy(
      `The permission policy could not be read safely${code}.`
    );
  }
}

export interface AntigravityCliPermissionDefaults {
  readonly agentMode: string | null;
  readonly toolPermission: string | null;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
Read Antigravity CLI defaults declared under `antigravity-cli` in `.rulesync/permissions.jsonc`.
*/
export function readAntigravityCliPermissionDefaults(
  file: string
): AntigravityCliPermissionDefaults {
  const read = readRegularPolicyFile(file);
  if (!read.ok) return { agentMode: null, toolPermission: null };
  const parsed = parseJsoncObject(read.content);
  if (parsed.value === null || !isRecord(parsed.value["antigravity-cli"])) {
    return { agentMode: null, toolPermission: null };
  }
  const section = parsed.value["antigravity-cli"];
  return {
    agentMode: nonEmptyStringOrNull(section.agentMode),
    toolPermission: nonEmptyStringOrNull(section.toolPermission)
  };
}

/**
Read the canonical permission policy from `.rulesync/permissions.jsonc`.

The source travels with the policy it states, so a reader that shows the
source and a reader that shows the values describe the same bytes.
*/
export function readPermissionPolicySource(file: string): PermissionPolicySource {
  const read = readRegularPolicyFile(file);
  if (!read.ok) return { read: read.result, content: null };
  return {
    read: parsePermissionPolicyContent(read.content),
    content: read.content
  };
}

/**
Read the canonical permission policy from `.rulesync/permissions.jsonc`.
*/
export function readPermissionPolicyFile(file: string): PermissionPolicyRead {
  return readPermissionPolicySource(file).read;
}

function parsePermissionPolicyContent(content: string): PermissionPolicyRead {
  const revision = permissionPolicyRevision(content);
  const parsed = parseJsoncObject(content);
  if (parsed.value === null) {
    return {
      status: "invalid",
      reason: parsed.reason ?? "The permission policy is not valid JSONC.",
      revision
    };
  }
  const codexcli = parsed.value.codexcli;
  if (!isRecord(codexcli)) {
    return {
      status: "invalid",
      reason: "The permission policy must declare a codexcli section.",
      revision
    };
  }
  const { policy, reason } = policyFromCodexSection(codexcli);
  if (reason !== undefined) {
    return { status: "invalid", reason, revision };
  }
  return { status: "valid", policy, revision };
}

/**
Read the applied permission policy from `$CODEX_HOME/config.toml`.

The composed user configuration is published as the policy it states and never
as text: it is the file that can hold credentials, and a browser payload has
no place for them. The canonical source beside it is a declaration and is
published whole.
*/
export function readAppliedPermissionPolicyFile(
  file: string
): PermissionPolicyRead {
  const read = readRegularPolicyFile(file, false);
  if (!read.ok) return read.result;
  const revision = permissionPolicyRevision(read.content);
  let parsed: unknown;
  try {
    parsed = parseToml(read.content);
  } catch {
    // Parser errors can quote arbitrary source lines from the composed
    // configuration, including credentials unrelated to this projection.
    return {
      status: "invalid",
      reason: "The applied permission policy is not valid TOML.",
      revision
    };
  }
  if (!isRecord(parsed)) {
    return {
      status: "invalid",
      reason: "The applied permission policy is not a TOML table.",
      revision
    };
  }
  const { policy, reason } = policyFromCodexSection(parsed);
  if (reason !== undefined) {
    return { status: "invalid", reason, revision };
  }
  return { status: "valid", policy, revision };
}
