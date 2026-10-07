import React from "react";

/**
 * A path that wraps between its segments and never inside one.
 *
 * Both of the alternatives a table cell can offer are wrong for a path, and the
 * Console was using each of them in a different column. `truncate` cuts the
 * cell and leaves an ellipsis: measured at 1440 against the live RuleSync
 * catalog, `/prompts`'s Canonical Source was cut on **70 of 70 rows**, because
 * the constant `.rulesync/commands/` prefix ate 18 of the 38 characters while
 * the discriminating part — the one that differs between rows — was the part
 * that disappeared. `/workspaces`'s Repository column truncated the same way.
 *
 * `break-words` is not the answer either. A path contains no spaces, so it is a
 * single unbreakable token to the line breaker and `overflow-wrap: break-word`
 * splits it at whatever character happens to fall past the edge — which the
 * contract forbids for discrete content ("stays atomic and wraps between items,
 * never mid-token").
 *
 * So the path declares its own break opportunities. `<wbr>` is exactly the
 * element for this: the browser may break there, nothing else is a legal break
 * point, and unlike a zero-width space baked into the text it does not become
 * an invisible character when the reader copies the path out.
 *
 * The children are plain strings and `<wbr>` elements and nothing else. A number
 * pushed into a children array is not a key — React renders it as a text node,
 * and the path came out as `.rulesync0/1commands1/2advance-autodev.md2`, which
 * is a corrupt identifier on a column whose entire job is to be exact.
 */
export function pathSegments(path: string): React.ReactNode[] {
  return path
    .split("/")
    .flatMap((part, index) =>
      index === 0
        ? part === ""
          ? []
          : [part]
        : [
            "/",
            React.createElement("wbr", { key: `wbr-${index}` }),
            ...(part === "" ? [] : [part])
          ]
    );
}

export interface PathTextProps {
  /** The path exactly as it should be copied; never shortened. */
  readonly path: string;
  /** Typography for the cell. Defaults to the shared monospace meta style. */
  readonly className?: string | undefined;
  /** Extra hover text; the path itself is always the fallback. */
  readonly title?: string | undefined;
}

export function PathText({
  path,
  className,
  title
}: PathTextProps): React.JSX.Element {
  return React.createElement(
    "span",
    {
      className: className ?? "font-mono text-fg-secondary break-normal",
      title: title ?? path
    },
    ...pathSegments(path)
  );
}
