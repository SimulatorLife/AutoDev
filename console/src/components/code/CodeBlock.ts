import React from "react";

/**
 * The Console's code and config surfaces.
 *
 * The target state requires "code/config editors" as a shared primitive. Seven
 * hand-typed class strings were spread across the prompt editor, the agent
 * detail page, and the memory record drawer for what is really two roles, and
 * they disagreed in ways that were visible side by side: the diff and the
 * committed source directly beneath it were two blocks in the same section,
 * one boxed and one with no border, background, or padding at all.
 *
 * These components own the chrome so a block of source looks the same wherever
 * it appears. They stay plain `<pre>` and `<textarea>` elements: the Console
 * ships no client JavaScript, so there is no syntax highlighter, no line
 * numbers, and no editor widget to install, and faking one would cost the
 * content its selectability and its accessibility.
 */

/**
 * A standalone block of source or configuration: bordered, padded, scrollable,
 * and set in the shared mono type.
 *
 * Height is deliberately absent. Tailwind resolves two utilities that set the
 * same property by their order in the generated stylesheet rather than by their
 * order in the class attribute, so appending a `max-h-*` here would silently
 * lose to whichever cap the stylesheet happens to emit last. Height is applied
 * through `CODE_BLOCK_HEIGHT_CLASS` instead, which is a closed set.
 */
export const CODE_BLOCK_CLASS =
  "overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-4 font-mono text-xs leading-relaxed text-fg-secondary";

/**
 * A fenced code block inside rendered prose. Tighter padding and no height cap,
 * because it flows with the surrounding paragraph rather than owning a section
 * of the page.
 */
export const CODE_SNIPPET_CLASS =
  "overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-3 font-mono text-xs leading-relaxed text-fg-secondary";

/**
 * The editable source surface.
 *
 * Written out rather than composed from `FIELD_CONTROL_CLASS`. That constant
 * sets `px-3 py-1.5`, so appending the roomier padding an editor needs would be
 * a same-property conflict whose winner depends on the stylesheet, not on this
 * source. The editor borrows the control's border, background, and focus tokens
 * and declares its own padding instead.
 */
export const CODE_EDITOR_CLASS =
  "w-full min-h-[32rem] resize-y overflow-auto rounded border border-border-strong bg-input p-4 font-mono text-xs leading-relaxed text-fg-secondary transition-colors hover:border-fg-muted disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Height caps for a standalone block. A closed set rather than a free-form
 * class, for the reason given on `CODE_BLOCK_CLASS`.
 */
export const CODE_BLOCK_HEIGHT_CLASS = {
  /** No cap: short content keeps its natural height. */
  auto: "",
  /** The default for a supporting block, such as a diff or a system prompt. */
  secondary: "max-h-[32rem]",
  /**
   * Taller, for a block that is the page's primary document rather than a
   * supporting one -- the canonical source an operator came to edit. A
   * supporting block beside it stays on `secondary`, which is the point.
   */
  primary: "max-h-[40rem]"
} as const;

export type CodeBlockHeight = keyof typeof CODE_BLOCK_HEIGHT_CLASS;

export interface CodeBlockProps {
  /** The exact text to display. Rendered verbatim, never reformatted. */
  readonly content: string;
  readonly height?: CodeBlockHeight | undefined;
  /** Accessible name when the block has no visible heading. */
  readonly ariaLabel?: string | undefined;
  /** Extra attributes, for the state flags the Console asserts on. */
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
  /** Positional utilities only. Carries no property the base class sets. */
  readonly className?: string | undefined;
}

export function CodeBlock({
  content,
  height = "secondary",
  ariaLabel,
  dataAttributes,
  className
}: CodeBlockProps): React.JSX.Element {
  return React.createElement(
    "pre",
    {
      className: `${CODE_BLOCK_CLASS} ${CODE_BLOCK_HEIGHT_CLASS[height]}${
        className === undefined ? "" : ` ${className}`
      }`,
      ...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
      ...dataAttributes
    },
    content
  );
}

export interface CodeEditorProps {
  /** Form control name the edited text submits under. */
  readonly name: string;
  readonly defaultValue: string;
  /** Accessible name for the editor; pair it with a visible heading. */
  readonly ariaLabel: string;
  readonly id?: string | undefined;
  readonly rows?: number | undefined;
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
}

/**
 * The editable source surface.
 *
 * A real `<textarea>` rather than a contenteditable or a widget: it submits
 * with a plain form post, it is operable by keyboard and announced correctly,
 * and it still works when the Console is served with scripting disabled.
 */
export function CodeEditor({
  name,
  defaultValue,
  ariaLabel,
  id,
  rows = 24,
  dataAttributes
}: CodeEditorProps): React.JSX.Element {
  return React.createElement("textarea", {
    id,
    name,
    rows,
    required: true,
    spellCheck: false,
    defaultValue,
    "aria-label": ariaLabel,
    className: CODE_EDITOR_CLASS,
    ...dataAttributes
  });
}
