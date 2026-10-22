import type { ControlApiMcpDeclaredServer } from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { TextField } from "../../components/forms/TextField.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

/**
 * One server's launch configuration, as the canonical declaration gives it.
 *
 * The header map is not in this form: a header is a name and a value, and a
 * form field cannot carry both without an encoding an operator has to learn.
 * The write leaves the headers the declaration already has alone, so an edit
 * here never drops one.
 */
export type McpDeclaredLaunch = Pick<
  ControlApiMcpDeclaredServer,
  "command" | "args" | "cwd" | "url" | "bearerTokenEnvVar"
>;

export interface McpDeclarationEditorProps {
  readonly name: string;
  readonly declared: McpDeclaredLaunch;
  /**
   * The revision the declaration was read at.
   *
   * The write is a compare-and-swap on it, so the form carries the revision
   * the operator's edit was written against rather than the revision the
   * declaration may have moved to while the page was open.
   */
  readonly revision: string;
}

/**
 * The canonical MCP declaration's own edit surface.
 *
 * It is a plain form, and that is the whole point. The Console's navigation
 * owner is the only thing that may drive its router, and a feature that
 * refreshes the page itself brings back the strand the owner exists to end: the
 * reducer applies the destination, React renders it, and the commit that would
 * move the address bar never runs. The owner also keeps what an operator
 * typed, because a browser restores the text in a form control when the write
 * it submitted is redirected back to the page. So the edit survives a refused
 * write without the Console having to hold on to it.
 */
export function McpDeclarationEditor({
  name,
  declared,
  revision
}: McpDeclarationEditorProps): React.JSX.Element {
  return React.createElement(
    "form",
    {
      method: "POST",
      action: `/api/mcps/${encodeURIComponent(name)}`,
      className: "flex flex-col gap-3",
      "aria-label": `Edit the canonical MCP declaration for ${name}`,
      "data-mcp-declaration-editor": "true"
    },
    React.createElement("input", {
      type: "hidden",
      name: "expectedRevision",
      value: revision
    }),
    React.createElement(TextField, {
      id: `mcp-command-${name}`,
      name: "command",
      label: "Command",
      defaultValue: declared.command ?? "",
      placeholder: "The executable that starts the server",
      dataAttributes: { "data-mcp-launch-field": "command" }
    }),
    React.createElement(TextField, {
      id: `mcp-args-${name}`,
      name: "args",
      label: "Arguments (one per line)",
      rows: 4,
      defaultValue: declared.args.join("\n"),
      placeholder: "The arguments the command is started with",
      dataAttributes: { "data-mcp-launch-field": "args" }
    }),
    React.createElement(TextField, {
      id: `mcp-cwd-${name}`,
      name: "cwd",
      label: "Working directory",
      defaultValue: declared.cwd ?? "",
      placeholder: "The directory the server is started in",
      dataAttributes: { "data-mcp-launch-field": "cwd" }
    }),
    React.createElement(TextField, {
      id: `mcp-url-${name}`,
      name: "url",
      label: "Endpoint URL",
      defaultValue: declared.url ?? "",
      placeholder: "The endpoint an HTTP server is reached at",
      dataAttributes: { "data-mcp-launch-field": "url" }
    }),
    React.createElement(TextField, {
      id: `mcp-bearer-token-${name}`,
      name: "bearerTokenEnvVar",
      label: "Bearer token environment variable",
      defaultValue: declared.bearerTokenEnvVar ?? "",
      placeholder: "The environment variable that holds the token",
      dataAttributes: { "data-mcp-launch-field": "bearerTokenEnvVar" }
    }),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "p",
        { className: `max-w-2xl ${MUTED_META_CLASS}` },
        "Saving writes the canonical declaration for the codexcli target and asks the Runtime to apply it. A cleared field removes that key from the declaration; the headers the declaration already carries are left alone."
      ),
      React.createElement(
        Button,
        { type: "submit", variant: "primary", testId: "mcp-declaration-save" },
        "Save and apply"
      )
    )
  );
}
