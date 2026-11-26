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
  applyEdits,
  type FormattingOptions,
  modify,
  parse as parseJsonc,
  type ParseError,
  printParseErrorCode
} from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

import { atomicWriteSync } from "../files/atomic-write.ts";

/**
The permission policy's one owner.

The permission policy of a Codex session is declared in `.rulesync/permissions.jsonc`
under `codexcli` (`approval_policy`, `approvals_reviewer`, `tools.web_search`),
and applied into `$CODEX_HOME/config.toml` via RuleSync + `compose-user-config`.
*/

const POLICY_KEYS = {
  approvalPolicy: ["codexcli", "approval_policy"],
  approvalsReviewer: ["codexcli", "approvals_reviewer"],
  webSearch: ["codexcli", "tools", "web_search"]
} as const satisfies Record<string, readonly string[]>;

export type PermissionPolicyKey = keyof typeof POLICY_KEYS;

const POLICY_MAX_BYTES = 1_000_000;
const JSONC_FORMATTING: FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: "\n"
};

export class PermissionPolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionPolicyConflictError";
  }
}

export class PermissionPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionPolicyValidationError";
  }
}

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
The policy keys a write may change.
*/
export interface PermissionPolicyUpdate {
  readonly approvalPolicy?: ApprovalPolicy | undefined;
  readonly approvalsReviewer?: string | undefined;
  readonly webSearch?: boolean | undefined;
}

export interface PermissionPolicyWrite {
  readonly revision: string;
  readonly policy: PermissionPolicy;
  readonly changed: boolean;
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
*/
export function readPermissionPolicyFile(file: string): PermissionPolicyRead {
  const read = readRegularPolicyFile(file);
  if (!read.ok) return read.result;
  return parsePermissionPolicyContent(read.content);
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

function validateKeyValue(
  key: PermissionPolicyKey,
  value: unknown
): ApprovalPolicy | string | boolean {
  if (key === "approvalPolicy") {
    const parsed = approvalPolicyFromConfig(value);
    if (parsed === null) {
      throw new PermissionPolicyValidationError(
        "codexcli.approval_policy must be one of never or on-request"
      );
    }
    return parsed;
  }
  if (key === "approvalsReviewer") {
    if (typeof value !== "string" || value.trim() === "") {
      throw new PermissionPolicyValidationError(
        "codexcli.approvals_reviewer must be a non-empty string"
      );
    }
    return value;
  }
  if (typeof value !== "boolean") {
    throw new PermissionPolicyValidationError(
      "codexcli.tools.web_search must be a boolean"
    );
  }
  return value;
}

/**
Change the permission policy in `.rulesync/permissions.jsonc`.

Uses compare-and-swap on the file's sha256 revision and edits via `jsonc-parser`
so existing comments and formatting outside the changed values survive.
*/
export function updatePermissionPolicy(input: {
  readonly file: string;
  readonly expectedRevision: string;
  readonly update: PermissionPolicyUpdate;
}): PermissionPolicyWrite {
  const keys = Object.entries(input.update).filter(
    ([, value]) => value !== undefined
  );
  if (keys.length === 0) {
    throw new PermissionPolicyValidationError(
      "A permission policy update must change at least one setting."
    );
  }
  for (const [key] of keys) {
    if (!Object.hasOwn(POLICY_KEYS, key)) {
      throw new PermissionPolicyValidationError(
        `Unknown permission policy setting: ${key}`
      );
    }
  }

  const read = readRegularPolicyFile(input.file);
  if (!read.ok) {
    throw new PermissionPolicyValidationError(read.result.reason);
  }
  const { content } = read;
  if (permissionPolicyRevision(content) !== input.expectedRevision) {
    throw new PermissionPolicyConflictError(
      "The permission policy changed since it was loaded."
    );
  }

  const current = parsePermissionPolicyContent(content);
  const currentPolicy = current.status === "valid" ? current.policy : null;

  const changed = keys.filter(([key]) => {
    if (currentPolicy === null) return true;
    const value = input.update[key as PermissionPolicyKey];
    if (value === undefined) return false;
    return currentPolicy[key as PermissionPolicyKey] !== value;
  });
  if (currentPolicy !== null && changed.length === 0) {
    return {
      revision: permissionPolicyRevision(content),
      policy: currentPolicy,
      changed: false
    };
  }

  let next = content;
  for (const [key, rawValue] of changed) {
    const typedKey = key as PermissionPolicyKey;
    const validated = validateKeyValue(typedKey, rawValue);
    const edits = modify(next, [...POLICY_KEYS[typedKey]], validated, {
      formattingOptions: JSONC_FORMATTING
    });
    next = applyEdits(next, edits);
  }

  const parsed = parseJsoncObject(next);
  if (parsed.value === null || !isRecord(parsed.value.codexcli)) {
    throw new PermissionPolicyValidationError(
      "The permission policy change would not produce a valid codexcli section."
    );
  }
  const { policy, reason } = policyFromCodexSection(parsed.value.codexcli);
  if (reason !== undefined) {
    throw new PermissionPolicyValidationError(
      `The permission policy change would not produce a valid policy: ${reason}`
    );
  }

  if (next === content) {
    return {
      revision: permissionPolicyRevision(content),
      policy,
      changed: false
    };
  }

  if (Buffer.byteLength(next, "utf8") > POLICY_MAX_BYTES) {
    throw new PermissionPolicyValidationError(
      "The permission policy change exceeds its safe size bound."
    );
  }
  persistPolicyFile(input.file, next);
  return {
    revision: permissionPolicyRevision(next),
    policy,
    changed: true
  };
}

function persistPolicyFile(file: string, next: string): void {
  atomicWriteSync(file, next, { mode: 0o644 });
  const persisted = readRegularPolicyFile(file);
  if (!persisted.ok || persisted.content !== next) {
    throw new PermissionPolicyConflictError(
      "The permission policy changed during the update."
    );
  }
}
