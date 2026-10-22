import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type ColumnDef,
  DataTable
} from "../src/components/tables/DataTable.ts";

/**
 * A table header is a label, and a label has to fit its column.
 *
 * The Console's own contract says it twice: "A column's weight must be large
 * enough for its own header", and a header wraps rather than truncating. The
 * browser acceptance measures the consequence: at 390px a header that does not
 * fit its column is clipped content, and a clipped header is a failure.
 *
 * The two rules are the same rule seen from two sides. The weight is the fix;
 * the wrap is the floor under it. Both are needed, because the floor is what
 * keeps an unmeasured table from clipping, and the weight is what keeps the
 * header on one line.
 */

interface Row {
  readonly id: string;
}

const COLUMNS: readonly ColumnDef<Row>[] = [
  {
    id: "availability",
    header: "Availability",
    cell: (row) => row.id
  }
];

test("a header label can shrink, so a narrow column wraps it rather than clipping it", () => {
  const markup = renderToStaticMarkup(
    React.createElement(DataTable<Row>, {
      data: [{ id: "sonnet" }],
      columns: COLUMNS,
      keyExtractor: (row) => row.id,
      emptyMessage: "No models."
    })
  );
  // A flex item's automatic minimum size is its min-content size, and
  // `overflow-wrap: break-word` does not reduce that size -- only
  // `overflow-wrap: anywhere` does. So a label that cannot shrink cannot
  // break either, and a column too narrow for one long word clips it.
  const label = markup.match(
    /<span[^>]*data-column-label="availability"[^>]*>/u
  )?.[0];
  assert.notEqual(label, undefined, "the header renders a label element");
  assert.match(
    label!,
    /class="[^"]*min-w-0[^"]*"/u,
    "the header's label has to be allowed to shrink below its min-content width"
  );
});

function sourceOf(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("a one-word header declares the weight its own header needs", () => {
  // "Availability" is one long word: it cannot wrap at a word boundary, so
  // its column has to be wide enough to hold it. The workspaces table
  // declares this header at 160, and the acceptance measures it fitting at
  // 390px there; the two model tables carry the same header and owe the same
  // weight.
  const tables = [
    [
      "the provider detail's model table",
      "../src/features/providers/ProviderDetailView.ts"
    ],
    [
      "the providers list's model table",
      "../src/features/providers/ProvidersView.ts"
    ]
  ] as const;
  for (const [name, path] of tables) {
    const source = sourceOf(path);
    const header = source.indexOf('header: "Availability"');
    assert.notEqual(header, -1, `${name} has an availability column`);
    const column = source.slice(header, header + 400);
    assert.match(
      column,
      /weight:\s*\d+/u,
      `${name} declares a weight for the availability column: a column's weight ` +
        "has to be large enough for its own header"
    );
  }
});
