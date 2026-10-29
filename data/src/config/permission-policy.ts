import { createHash, randomUUID } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import type {
  ApprovalPolicy,
  PermissionPolicy,
  SandboxMode
} from "@simulatorlife/autodev-core";
import { parse as parseToml } from "smol-toml";

/**
 * The permission policy's one owner.
 *
 * The permission policy of a Codex session is declared in the portable source
 * (`config/config.autodev.toml`) and in the role declarations
 * (`agents/roles/<role>.toml`). Nothing else states it, so this module is the
 * only place that decides what those files mean, what a policy value is, and
 * how a policy is changed.
 *
 * It used to be two places that said the same thing without reading either
 * file: the Runtime published a policy block of literals while naming the
 * portable source as its origin, and Data's config repository published the
 * same literals to nobody. The literals happened to agree with the file, which
 * is what hid them: changing `sandbox_mode` in the portable source changed
 * nothing the Console displayed, and the Control API kept naming a file it had
 * never read. A role's sandbox was worse than a constant -- it was derived
 * from a boolean, so a role declared `danger-full-access` was reported as
 * `workspace-write`, and the Console named the most privileged roles in the
 * product as sandboxed.
 *
 * The vocabulary is the file's, not this module's: the portable source states
 * `sandbox_mode` in the vocabulary Codex configures sessions in, and the
 * product's own vocabulary (`core`'s `SandboxMode`) is what the Console shows.
 * The translation between the two lives here, once, so no reader can invent a
 * third one.
 */

/** The sandbox modes the portable source declares a session in. */
const CONFIG_SANDBOX_MODES = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  "danger-full-access": "unrestricted"
} as const satisfies Record<string, SandboxMode>;

/** The approval policies the portable source declares. */
const CONFIG_APPROVAL_POLICIES = new Set<string>([
  "never",
  "always",
  "on-demand"
]);

/**
 * The policy keys, and where each one lives in the portable source.
 *
 * Three are top-level keys and two live inside a table, which is why a write
 * has to know the section a key belongs to rather than search for the key's
 * name anywhere in the file.
 */
const POLICY_KEYS = {
  approvalPolicy: { key: "approval_policy", section: null },
  sandboxMode: { key: "sandbox_mode", section: null },
  approvalsReviewer: { key: "approvals_reviewer", section: null },
  networkAccess: {
    key: "network_access",
    section: "sandbox_workspace_write"
  },
  webSearch: { key: "web_search", section: "tools" }
} as const satisfies Record<
  string,
  { readonly key: string; readonly section: string | null }
>;

export type PermissionPolicyKey = keyof typeof POLICY_KEYS;

/** The file's own bound: a policy file that is larger than this is not one. */
const POLICY_MAX_BYTES = 1_000_000;

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

/** What a read of the portable source found. */
export type PermissionPolicyRead =
  | {
      readonly status: "valid";
      readonly policy: PermissionPolicy;
      /** The sha256 of the file's exact bytes: the token a write is decided on. */
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

/** The policy keys a write may change. */
export interface PermissionPolicyUpdate {
  readonly approvalPolicy?: ApprovalPolicy | undefined;
  readonly sandboxMode?: SandboxMode | undefined;
  readonly approvalsReviewer?: string | undefined;
  readonly networkAccess?: boolean | undefined;
  readonly webSearch?: boolean | undefined;
}

export interface PermissionPolicyWrite {
  readonly revision: string;
  readonly policy: PermissionPolicy;
  readonly changed: boolean;
}

/**
 * The revision of a source file: the sha256 of its exact bytes.
 *
 * The bytes, not the meaning: a reformatting edit that changes no policy is
 * still a change to the file, and a write decided on the older file has to be
 * refused rather than applied over it.
 */
export function permissionPolicyRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The generation of a policy's values.
 *
 * The revision and the generation answer two different questions. The revision
 * is "has this file changed?", and it is what a write is decided on. The
 * generation is "do these values agree?", and it is what the desired state and
 * the applied state are compared by: the applied file is a different file with
 * different bytes, so its revision can never equal the canonical file's.
 */
export function permissionPolicyGeneration(policy: PermissionPolicy): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        policy.approvalPolicy,
        policy.sandboxMode,
        policy.approvalsReviewer,
        policy.networkAccess,
        policy.webSearch
      ]),
      "utf8"
    )
    .digest("hex");
}

/**
 * The sandbox mode the portable source's vocabulary names, or null.
 *
 * A mode this module does not know is not a mode it may report: the product
 * names three, and a fourth would be a configuration the product cannot honour.
 */
export function sandboxModeFromConfig(value: unknown): SandboxMode | null {
  if (typeof value !== "string") return null;
  return (
    CONFIG_SANDBOX_MODES[value as keyof typeof CONFIG_SANDBOX_MODES] ?? null
  );
}

/**
 * The portable source's vocabulary for a sandbox mode.
 *
 * The inverse of {@link sandboxModeFromConfig}, and the only place the product's
 * vocabulary is turned back into the file's.
 */
export function sandboxModeToConfig(mode: SandboxMode): string {
  const entry = Object.entries(CONFIG_SANDBOX_MODES).find(
    ([, product]) => product === mode
  );
  if (!entry) {
    throw new PermissionPolicyValidationError(
      `Unsupported sandbox mode: ${mode}`
    );
  }
  return entry[0];
}

/** The approval policy the portable source declares, or null. */
export function approvalPolicyFromConfig(
  value: unknown
): ApprovalPolicy | null {
  if (typeof value !== "string") return null;
  return CONFIG_APPROVAL_POLICIES.has(value) ? (value as ApprovalPolicy) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The policy the portable source states.
 *
 * Every key is required. A portable source that omits one has not said what
 * that key is, and a policy that fills the gap with a default would report a
 * setting the operator never chose.
 */
function policyFromParsed(parsed: Record<string, unknown>): {
  readonly policy: PermissionPolicy;
  readonly reason?: string;
} {
  const approvalPolicy = approvalPolicyFromConfig(parsed.approval_policy);
  if (approvalPolicy === null) {
    return {
      policy: emptyPolicy(),
      reason: "approval_policy must be one of never, always or on-demand"
    };
  }
  const sandboxMode = sandboxModeFromConfig(parsed.sandbox_mode);
  if (sandboxMode === null) {
    return {
      policy: emptyPolicy(),
      reason:
        "sandbox_mode must be one of read-only, workspace-write or danger-full-access"
    };
  }
  const approvalsReviewer = parsed.approvals_reviewer;
  if (
    typeof approvalsReviewer !== "string" ||
    approvalsReviewer.trim() === ""
  ) {
    return {
      policy: emptyPolicy(),
      reason: "approvals_reviewer must be a non-empty string"
    };
  }
  const workspaceWrite = parsed.sandbox_workspace_write;
  if (
    !isRecord(workspaceWrite) ||
    typeof workspaceWrite.network_access !== "boolean"
  ) {
    return {
      policy: emptyPolicy(),
      reason: "sandbox_workspace_write.network_access must be a boolean"
    };
  }
  const tools = parsed.tools;
  if (!isRecord(tools) || typeof tools.web_search !== "boolean") {
    return {
      policy: emptyPolicy(),
      reason: "tools.web_search must be a boolean"
    };
  }
  return {
    policy: {
      approvalPolicy,
      sandboxMode,
      approvalsReviewer,
      networkAccess: workspaceWrite.network_access,
      webSearch: tools.web_search
    }
  };
}

/**
 * The policy a source that states nothing may be read as.
 *
 * Only ever returned beside a reason: a caller that gets this has failed to
 * read a policy, and the values are there so the shape of the answer is the
 * same, not so a caller can render them.
 */
function emptyPolicy(): PermissionPolicy {
  return {
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    approvalsReviewer: "",
    networkAccess: false,
    webSearch: false
  };
}

/**
 * Read the permission policy from the portable source.
 *
 * The read refuses as loudly as the write: a policy that cannot be read is not
 * a policy with default values, and reporting defaults for a file that exists
 * but cannot be parsed would answer a question the operator never asked.
 */
export function readPermissionPolicyFile(file: string): PermissionPolicyRead {
  let content: string;
  try {
    if (!statSync(file).isFile()) {
      return {
        status: "unavailable",
        reason: "The permission policy is not a regular file.",
        revision: null
      };
    }
    content = readFileSync(file, "utf8");
  } catch (error) {
    return {
      status: "unavailable",
      reason:
        error instanceof Error && "code" in error
          ? `The permission policy could not be read (${String((error as NodeJS.ErrnoException).code)}).`
          : "The permission policy could not be read.",
      revision: null
    };
  }
  if (Buffer.byteLength(content, "utf8") > POLICY_MAX_BYTES) {
    return {
      status: "invalid",
      reason:
        "The permission policy exceeds its safe size bound and was not read.",
      revision: permissionPolicyRevision(content)
    };
  }
  const revision = permissionPolicyRevision(content);
  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch (error) {
    return {
      status: "invalid",
      reason:
        error instanceof Error
          ? `The permission policy is not valid TOML: ${error.message}`
          : "The permission policy is not valid TOML.",
      revision
    };
  }
  if (!isRecord(parsed)) {
    return {
      status: "invalid",
      reason: "The permission policy is not a TOML table.",
      revision
    };
  }
  const { policy, reason } = policyFromParsed(parsed);
  if (reason !== undefined) {
    return { status: "invalid", reason, revision };
  }
  return { status: "valid", policy, revision };
}

/**
 * The sandbox mode each role declares.
 *
 * A role that declares none inherits the policy's: the role's own
 * configuration is layered over the portable source, so an absent key is the
 * source's value rather than an unstated one.
 *
 * A role whose declaration names a mode this product does not support is
 * reported as unknown rather than as the nearest supported one: a role that
 * cannot be sandboxed the way it asks is not a role whose sandbox is known.
 *
 * The fallback is the policy's mode, and it is null when the policy was not
 * observed. A role that declares no mode under a policy that could not be read
 * has no observed sandbox: the nearest mode the product knows is not a mode
 * any source stated.
 */
export function readRoleSandboxModes(
  rolesDirectory: string,
  fallback: SandboxMode | null
): Readonly<Record<string, SandboxMode | null>> {
  const modes: Record<string, SandboxMode | null> = {};
  let entries: string[];
  try {
    entries = readdirSync(rolesDirectory);
  } catch {
    return modes;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".toml")) continue;
    const role = entry.slice(0, -".toml".length);
    modes[role] = roleSandboxMode(path.join(rolesDirectory, entry), fallback);
  }
  return modes;
}

/**
 * The sandbox mode one role declares.
 *
 * The role declarations are the canonical source for what a role may do, and
 * this is the one place that reads the mode out of them. The projection the
 * Runtime installs (`config/execution-contract.json`) keeps a boolean instead,
 * so this cannot be answered from the projection without losing the mode.
 */
export function roleSandboxMode(
  roleFile: string,
  fallback: SandboxMode | null
): SandboxMode | null {
  let content: string;
  try {
    content = readFileSync(roleFile, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.sandbox_mode === undefined) return fallback;
  return sandboxModeFromConfig(parsed.sandbox_mode);
}

/**
 * A line of the portable source, and the section it belongs to.
 *
 * The section is what makes a write safe: `network_access` appears in the
 * portable source under `sandbox_workspace_write`, and a key of the same name
 * in another table is a different key.
 */
/** A table header, or an array-of-tables header. */
const SECTION_HEADER_PATTERN = /^\s*\[\[?([^\]]+)\]?\]\s*$/u;
/** A key's own line. */
const ENTRY_PATTERN = /^\s*([A-Za-z0-9_-]+)\s*=/u;

/**
 * A table in the source: the lines that belong to one header.
 *
 * The root table is the lines before the first header, and a header ends the
 * table above it. An array-of-tables header ends the table above it too: the
 * entries under one belong to that array, not to the table before it.
 */
interface SourceBlock {
  /** The table's name, or null for the root table. */
  readonly name: string | null;
  /** An array-of-tables header, whose entries are not the table's keys. */
  readonly isArray: boolean;
  /** The first line of the table's entries. */
  readonly start: number;
  /** The line after the table's last entry. */
  readonly end: number;
}

/** The source's tables, in the order they appear. */
function sourceBlocks(lines: readonly string[]): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let current: { name: string | null; isArray: boolean; start: number } = {
    name: null,
    isArray: false,
    start: 0
  };
  for (const [index, line] of lines.entries()) {
    const header = SECTION_HEADER_PATTERN.exec(line ?? "");
    if (!header) continue;
    const name = header[1];
    if (name === undefined) continue;
    blocks.push({ ...current, end: index });
    current = {
      name: name.trim(),
      isArray: header[0].includes("[["),
      start: index + 1
    };
  }
  blocks.push({ ...current, end: lines.length });
  return blocks;
}

/**
 * How much a line opens or closes.
 *
 * Brackets inside a string are not brackets: a value like
 * `exporter = { otlp-http = { endpoint = "http://x" } }` carries a colon and
 * slashes that mean nothing to the counter.
 */
function bracketDepth(text: string): number {
  let depth = 0;
  let inString = false;
  for (const character of text) {
    if (inString) {
      if (character === "\\") continue;
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
  }
  return depth;
}

/**
 * The lines an entry occupies.
 *
 * A value may span lines -- an array of tools, a table written across lines --
 * so an entry ends where its brackets and braces balance. Replacing only the
 * first line of such an entry would leave the rest of the old value behind.
 */
function entryExtent(lines: readonly string[], start: number): number {
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    depth += bracketDepth(lines[index] ?? "");
    if (depth <= 0) return index + 1;
  }
  return lines.length;
}

/** A TOML string literal, escaped. */
function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;
}

/** How a policy value is written into the source. */
function tomlValue(key: PermissionPolicyKey, value: unknown): string {
  if (key === "approvalPolicy") {
    if (!approvalPolicyFromConfig(value)) {
      throw new PermissionPolicyValidationError(
        "approval_policy must be one of never, always or on-demand"
      );
    }
    return tomlString(String(value));
  }
  if (key === "sandboxMode") {
    if (sandboxModeFromConfig(value) === null) {
      throw new PermissionPolicyValidationError(
        "sandbox_mode must be one of read-only, workspace-write or danger-full-access"
      );
    }
    return tomlString(sandboxModeToConfig(value as SandboxMode));
  }
  if (key === "approvalsReviewer") {
    if (typeof value !== "string" || value.trim() === "") {
      throw new PermissionPolicyValidationError(
        "approvals_reviewer must be a non-empty string"
      );
    }
    return tomlString(value);
  }
  if (typeof value !== "boolean") {
    throw new PermissionPolicyValidationError(
      `${POLICY_KEYS[key].key} must be a boolean`
    );
  }
  return value ? "true" : "false";
}

/**
 * The table a policy key lives in.
 *
 * The root table holds the keys that are not inside one, and a key that
 * belongs to a table is looked up in that table only: `network_access` in
 * another table is a different key.
 */
function policyBlock(
  blocks: readonly SourceBlock[],
  section: string | null
): SourceBlock | undefined {
  return section === null
    ? blocks.find((candidate) => candidate.name === null)
    : blocks.find(
        (candidate) => candidate.name === section && !candidate.isArray
      );
}

/** The line the key's own entry starts on, or -1 when the table has none. */
function findEntryStart(
  lines: readonly string[],
  block: SourceBlock,
  name: string
): number {
  for (let index = block.start; index < block.end; index += 1) {
    const match = ENTRY_PATTERN.exec(lines[index] ?? "");
    if (!match || match[1] !== name) continue;
    return index;
  }
  return -1;
}

/**
 * The line a key that the table does not carry is added at.
 *
 * It goes after the table's last entry, so it lands inside the table rather
 * than after the table's trailing comments -- a comment explains what follows
 * it, and a key inserted between the two would detach it from the thing it
 * explains.
 */
function insertPosition(lines: readonly string[], block: SourceBlock): number {
  for (let index = block.end - 1; index >= block.start; index -= 1) {
    if (!ENTRY_PATTERN.test(lines[index] ?? "")) continue;
    return index + 1;
  }
  return block.start;
}

/**
 * The source with one policy key set.
 *
 * The edit is made on the text rather than by re-serialising the parsed
 * document, because the portable source is mostly comments: they are the
 * explanation of what each key means, and a serializer would drop every one of
 * them. Only the key's own lines change; everything else is copied byte for
 * byte.
 */
function setPolicyKey(
  content: string,
  key: PermissionPolicyKey,
  value: unknown
): string {
  const { key: name, section } = POLICY_KEYS[key];
  const literal = tomlValue(key, value);
  const lines = content.split("\n");
  const block = policyBlock(sourceBlocks(lines), section);
  if (!block) {
    throw new PermissionPolicyValidationError(
      `The permission policy has no ${section ?? "root"} table to change ${name} in.`
    );
  }

  const entryStart = findEntryStart(lines, block, name);
  const at = entryStart >= 0 ? entryStart : insertPosition(lines, block);
  const end = entryStart >= 0 ? entryExtent(lines, entryStart) : at;
  return [
    ...lines.slice(0, at),
    `${name} = ${literal}`,
    ...lines.slice(end)
  ].join("\n");
}

/**
 * Change the permission policy in the portable source.
 *
 * The write is a compare-and-swap on the file's revision, so a change decided
 * on a policy file that has since moved is refused rather than applied over
 * the newer one. The values are validated before the file is touched, and the
 * result is parsed again before it is written, so a source that would not
 * parse is never written.
 */
export function updatePermissionPolicy(input: {
  readonly file: string;
  /** The policy file's own revision, so a stale read cannot overwrite a newer one. */
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
    if (!(key in POLICY_KEYS)) {
      throw new PermissionPolicyValidationError(
        `Unknown permission policy setting: ${key}`
      );
    }
  }

  let content: string;
  try {
    if (!statSync(input.file).isFile()) {
      throw new PermissionPolicyConflictError(
        "The permission policy is not a regular file."
      );
    }
    content = readFileSync(input.file, "utf8");
  } catch (error) {
    if (error instanceof PermissionPolicyConflictError) throw error;
    throw new PermissionPolicyValidationError(
      "The permission policy could not be read, so nothing was changed."
    );
  }
  if (Buffer.byteLength(content, "utf8") > POLICY_MAX_BYTES) {
    throw new PermissionPolicyValidationError(
      "The permission policy exceeds its safe size bound and was not modified."
    );
  }
  if (permissionPolicyRevision(content) !== input.expectedRevision) {
    throw new PermissionPolicyConflictError(
      "The permission policy changed since it was loaded."
    );
  }

  const current = readPermissionPolicyFile(input.file);
  const currentPolicy = current.status === "valid" ? current.policy : null;

  // Only the settings that differ are written. A write carries the whole
  // policy, because the control that made it shows the whole policy, and
  // rewriting a key that already says what the operator chose would change
  // the file's bytes for no reason -- and a file whose bytes moved for no
  // reason refuses every other operator's write.
  const changed = keys.filter(([key]) => {
    if (currentPolicy === null) return true;
    const value = input.update[key as PermissionPolicyKey];
    if (value === undefined) return false;
    return currentPolicy[key as PermissionPolicyKey] !== value;
  });
  if (changed.length === 0 && currentPolicy !== null) {
    return {
      revision: permissionPolicyRevision(content),
      policy: currentPolicy,
      changed: false
    };
  }

  let next = content;
  for (const [key, value] of changed) {
    next = setPolicyKey(next, key as PermissionPolicyKey, value);
  }

  // The new source is parsed before it is written, so a source that would not
  // parse is never written.
  let parsed: unknown;
  try {
    parsed = parseToml(next);
  } catch (error) {
    throw new PermissionPolicyValidationError(
      error instanceof Error
        ? `The permission policy change would not produce a valid source: ${error.message}`
        : "The permission policy change would not produce a valid source."
    );
  }
  if (!isRecord(parsed)) {
    throw new PermissionPolicyValidationError(
      "The permission policy change would not produce a valid source."
    );
  }
  const { policy, reason } = policyFromParsed(parsed);
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

  persistPolicyFile(input.file, next);
  return {
    revision: permissionPolicyRevision(next),
    policy,
    changed: true
  };
}

/**
 * Write through a temporary file and rename over the target, then confirm the
 * bytes landed.
 *
 * The rename is what makes this a replace rather than a truncate, so a reader
 * never observes half a policy file. The confirmation is separate because the
 * write reporting success is not evidence that it succeeded.
 */
function persistPolicyFile(file: string, next: string): void {
  const temporaryPath = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporaryPath, next, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644
    });
    renameSync(temporaryPath, file);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file was never created, so there is nothing to clear.
    }
    throw error;
  }
  const persisted = readFileSync(file, "utf8");
  if (persisted !== next) {
    throw new PermissionPolicyConflictError(
      "The permission policy changed during the update."
    );
  }
}
