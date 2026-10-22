"use client";

import { useRouter } from "next/navigation.js";
import React, { startTransition, useState } from "react";

import { Button } from "../../components/forms/Button.ts";
import { TextField } from "../../components/forms/TextField.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { gridRowClass } from "../../components/panels/DetailGrid.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

/**
 * The canonical edit surface for one MCP server's launch configuration.
 *
 * The declaration is the canonical source, so this editor writes it through the
 * Control API and nothing else: the Console never edits the file, and it never
 * decides what the Runtime published. The Runtime applies the projection and
 * reports what it observed, and the page shows that verdict next to the
 * applied configuration.
 *
 * The editor is a client island because a refused write has to keep the
 * operator's edit: a declaration that moved under the edit is a conflict, and
 * the operator's next move is to look at what changed and decide again -- not
 * to have the edit silently replaced by the configuration that won.
 */

/**
 * What the editor is doing.
 *
 * One state, so the editor cannot report two things at once: a refused write
 * is a refusal with a reason, and a request that never got an answer is a
 * failure.
 */
type EditorState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "saved" }
  | { readonly kind: "conflict" }
  | { readonly kind: "failed"; readonly reason: string };

/** The launch keys one MCP server declares. */
interface LaunchFields {
  readonly command: string;
  readonly args: string;
  readonly cwd: string;
  readonly url: string;
  readonly bearerTokenEnvVar: string;
}

/**
 * The operator's edit, read from the controls on the page.
 *
 * The controls are ordinary form controls, so the edit the operator made is in
 * the document rather than in this island's state. Reading it at the moment of
 * the write is also what keeps the edit across a refused write: the island
 * re-renders, and the controls keep what the operator typed.
 */
function readFields(name: string): LaunchFields | null {
  const read = (field: string): string | null => {
    const control = document.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(`#mcp-${field}-${CSS.escape(name)}`);
    return control === null ? null : control.value;
  };
  const command = read("command");
  const args = read("args");
  const cwd = read("cwd");
  const url = read("url");
  const bearerTokenEnvVar = read("bearer-token-env-var");
  if (
    command === null ||
    args === null ||
    cwd === null ||
    url === null ||
    bearerTokenEnvVar === null
  ) {
    return null;
  }
  return { command, args, cwd, url, bearerTokenEnvVar };
}

/**
 * The launch keys the operator's edit carries.
 *
 * A field the operator cleared is a key that is removed from the declaration,
 * which is what clearing a field means. An argument list that is empty is a
 * key that is removed rather than an empty list, because an empty list is a
 * configuration no server is started with.
 */
function launchFor(fields: LaunchFields): {
  readonly command: string | null;
  readonly args: readonly string[] | null;
  readonly cwd: string | null;
  readonly url: string | null;
  readonly bearerTokenEnvVar: string | null;
} {
  const args = fields.args
    .split("\n")
    .map((argument) => argument.trim())
    .filter((argument) => argument.length > 0);
  return {
    command: fields.command.trim().length === 0 ? null : fields.command.trim(),
    args: args.length === 0 ? null : args,
    cwd: fields.cwd.trim().length === 0 ? null : fields.cwd.trim(),
    url: fields.url.trim().length === 0 ? null : fields.url.trim(),
    bearerTokenEnvVar:
      fields.bearerTokenEnvVar.trim().length === 0
        ? null
        : fields.bearerTokenEnvVar.trim()
  };
}

/**
 * The router, when there is one.
 *
 * The editor is rendered outside the App Router in the Console's own unit
 * tests, where the router context is not mounted and reading it throws. The
 * refresh is a convenience -- the applied configuration is re-read when the
 * page is -- so a missing router is not a reason to refuse the write.
 */
function useRouterSafely(): ReturnType<typeof useRouter> | null {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    router = useRouter();
  } catch {
    // In environments without AppRouterContext (such as SSR or unit tests)
  }
  return router;
}

export function McpDeclarationEditor({
  name,
  target,
  revision,
  declared
}: {
  readonly name: string;
  /** The target whose declaration the write lands on. */
  readonly target: string;
  /** The revision of the declaration the editor was filled from. */
  readonly revision: string | null;
  /** What the declaration carries for this server, or `null` when it was not read. */
  readonly declared: {
    readonly command: string | null;
    readonly args: readonly string[];
    readonly cwd: string | null;
    readonly url: string | null;
    readonly bearerTokenEnvVar: string | null;
  } | null;
}): React.JSX.Element {
  const router = useRouterSafely();
  const [state, setState] = useState<EditorState>({ kind: "idle" });

  const editable = revision !== null && declared !== null;

  const save = async (): Promise<void> => {
    if (state.kind === "pending" || revision === null) return;
    const fields = readFields(name);
    if (fields === null) {
      setState({
        kind: "failed",
        reason: "The launch configuration controls are not on the page."
      });
      return;
    }
    setState({ kind: "pending" });
    try {
      const response = await fetch(`/api/mcps/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: revision,
          launch: launchFor(fields)
        })
      });
      const body: unknown = await response.json();
      const answer =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      const reason = typeof answer.error === "string" ? answer.error : null;
      if (response.status === 409) {
        // The declaration moved under the edit. The edit stays; the operator
        // decides what to do with it.
        setState({ kind: "conflict" });
        return;
      }
      if (!response.ok) {
        setState({
          kind: "failed",
          reason:
            reason ??
            "The canonical MCP declaration could not be written. The Console did not say why."
        });
        return;
      }
      setState({ kind: "saved" });
      // The applied configuration and the reconciliation are the Runtime's
      // readings, so the page is re-read rather than patched here.
      startTransition(() => router?.refresh());
    } catch {
      setState({
        kind: "failed",
        reason: "The canonical MCP declaration could not be written."
      });
    }
  };

  const pending = state.kind === "pending";
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3", "data-mcp-declaration-editor": "true" },
    React.createElement(
      "h4",
      { className: SECTION_HEADING_CLASS },
      `Declared configuration for the ${target} target`
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      editable
        ? `This is the launch configuration the canonical declaration gives the ${target} target. Saving writes the declaration, applies the projection and reports what the Runtime published.`
        : "The canonical declaration could not be read, so there is nothing to edit here."
    ),
    React.createElement(
      "div",
      { className: gridRowClass(2, "gap-3") },
      React.createElement(TextField, {
        name: "mcp-command",
        id: `mcp-command-${name}`,
        label: "Command",
        defaultValue: declared?.command ?? "",
        disabled: !editable
      }),
      React.createElement(TextField, {
        name: "mcp-args",
        id: `mcp-args-${name}`,
        label: "Arguments (one per line)",
        rows: 3,
        defaultValue: declared?.args.join("\n") ?? "",
        disabled: !editable
      }),
      React.createElement(TextField, {
        name: "mcp-url",
        id: `mcp-url-${name}`,
        label: "Endpoint URL",
        defaultValue: declared?.url ?? "",
        disabled: !editable
      }),
      React.createElement(TextField, {
        name: "mcp-cwd",
        id: `mcp-cwd-${name}`,
        label: "Working directory",
        defaultValue: declared?.cwd ?? "",
        disabled: !editable
      }),
      React.createElement(TextField, {
        name: "mcp-bearer-token-env-var",
        id: `mcp-bearer-token-env-var-${name}`,
        label: "Bearer token environment variable",
        defaultValue: declared?.bearerTokenEnvVar ?? "",
        disabled: !editable
      })
    ),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2" },
      React.createElement(
        Button,
        {
          type: "button",
          variant: "primary",
          onClick: () => void save(),
          busy: pending,
          disabled: !editable,
          testId: "mcp-declaration-save"
        },
        pending ? "Saving…" : "Save and apply"
      ),
      React.createElement(
        "p",
        {
          "aria-live": "polite",
          "aria-atomic": "true",
          className: "sr-only",
          "data-mcp-declaration-status": "true"
        },
        state.kind === "pending"
          ? "Saving the canonical MCP declaration."
          : state.kind === "saved"
            ? "The canonical MCP declaration was written and applied."
            : state.kind === "conflict"
              ? "The canonical MCP declaration changed before the write was applied."
              : state.kind === "failed"
                ? state.reason
                : ""
      )
    ),
    state.kind === "saved"
      ? React.createElement(
          "p",
          {
            className: CALLOUT_WARNING_CLASS,
            role: "status",
            "data-mcp-declaration-saved": "true"
          },
          "The canonical declaration was written and the projection applied. The applied configuration below is what the Runtime published."
        )
      : null,
    state.kind === "conflict"
      ? React.createElement(
          "p",
          {
            className: CALLOUT_ERROR_CLASS,
            role: "alert",
            "data-mcp-declaration-conflict": "true"
          },
          "The canonical declaration changed before this write was applied, so it was refused. Your edit is still here; reload the page to see what changed before saving again."
        )
      : null,
    state.kind === "failed"
      ? React.createElement(
          "p",
          {
            className: CALLOUT_ERROR_CLASS,
            role: "alert",
            "data-mcp-declaration-failure": "true"
          },
          state.reason
        )
      : null
  );
}
