/**
 * The renderer for a prompt author's own Markdown.
 *
 * It lives in its own module because two surfaces render it: the page shows
 * the saved body, and the preview island shows the body of the source the
 * operator has not saved yet. A renderer each of them carried would be two
 * renderers, and the unsaved preview would stop looking like the saved one
 * the moment one of them changed.
 */

import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";

import { CODE_SNIPPET_CLASS } from "../../components/code/CodeBlock.ts";
import { TAG_SHAPE } from "../../components/status/Tag.ts";
import { MUTED_BODY_CLASS } from "../../components/ui/text-classes.ts";

/**
 * Renderer for the prompt author's own Markdown, shown as a preview inside the
 * page.
 *
 * The prompt body is content *within* this page, not a page of its own, so its
 * headings are demoted three levels past the Console's own body sections. A
 * prompt that opens with an `# H1` used to inject a second page-level heading
 * halfway down the outline — below Console sections and above the shell's
 * `h1` — which is what a document outline is supposed to rule out.
 */
const PROMPT_MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) =>
    React.createElement(
      "h4",
      { className: "mb-3 text-xl font-semibold text-fg" },
      children
    ),
  h2: ({ children }) =>
    React.createElement(
      "h5",
      { className: "mb-2 mt-4 text-lg font-semibold text-fg" },
      children
    ),
  h3: ({ children }) =>
    React.createElement(
      "h6",
      { className: "mb-2 mt-3 text-base font-semibold text-fg" },
      children
    ),
  p: ({ children }) =>
    React.createElement(
      "p",
      { className: "mb-3 text-sm text-fg-secondary" },
      children
    ),
  ul: ({ children }) =>
    React.createElement(
      "ul",
      { className: "mb-3 list-disc space-y-1 pl-6 text-sm text-fg-secondary" },
      children
    ),
  ol: ({ children }) =>
    React.createElement(
      "ol",
      {
        className: "mb-3 list-decimal space-y-1 pl-6 text-sm text-fg-secondary"
      },
      children
    ),
  li: ({ children }) => React.createElement("li", null, children),
  blockquote: ({ children }) =>
    React.createElement(
      "blockquote",
      {
        className: `mb-3 border-l-2 border-border-strong pl-4 ${MUTED_BODY_CLASS}`
      },
      children
    ),
  pre: ({ children }) =>
    React.createElement(
      "pre",
      { className: `${CODE_SNIPPET_CLASS} mb-3` },
      children
    ),
  code: ({ children }) =>
    // Markdown inline code, so the content is whatever the prompt author wrote
    // and can be any length. An inline element, so it cannot be a Tag; it
    // titles itself instead.
    React.createElement(
      "code",
      {
        title: children,
        className: `${TAG_SHAPE} border-transparent bg-input font-mono text-fg-secondary`
      },
      children
    ),
  a: ({ href, children }) =>
    React.createElement(
      "a",
      {
        href,
        target: "_blank",
        rel: "noreferrer",
        className: "text-accent underline underline-offset-2"
      },
      children
    ),
  hr: () => React.createElement("hr", { className: "my-4 border-border" })
};

/**
 * A prompt body, rendered.
 *
 * The body is content *within* a page, not a page of its own, so its headings
 * are demoted three levels past the Console's own body sections. A prompt that
 * opens with an `# H1` used to inject a second page-level heading halfway down
 * the outline -- below Console sections and above the shell's `h1` -- which is
 * what a document outline is supposed to rule out.
 */
export function PromptMarkdown({
  body
}: {
  readonly body: string;
}): React.JSX.Element {
  return React.createElement(ReactMarkdown, {
    components: PROMPT_MARKDOWN_COMPONENTS,
    children: body
  });
}
