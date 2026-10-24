import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type ColumnDef,
  DataTable
} from "../src/components/tables/DataTable.ts";

/**
 * A list table has to fit the column it is given.
 *
 * A table's width is the sum of its declared column weights, and the Console
 * gives a list table one content column. A budget larger than that column is
 * not a table that scrolls: it is a table whose last column is off the page,
 * with nothing at the right edge to say there was anything there.
 *
 * That is not a hypothetical. Four of the Console's list tables declared a
 * budget larger than the column they were given -- the agents table by 98px,
 * the providers table by 122px, the MCPs table by 184px and the workspaces
 * table by 116px -- and the columns that fell off the right edge were the
 * MCPs column, the Agent Limits column and the Connection column. The
 * providers table's reasoning-effort selector, one of the three controls every
 * role carries, was only reachable by scrolling a table that gave no sign
 * there was anything to the right.
 *
 * The budgets were larger than the room they were declared against, so the
 * scroll bought nothing. The same columns and the same values fit inside the
 * content column once the weights were measured against it, which is what the
 * numbers below are: each column's own content budget and its own header, not
 * a share of a total that was never reconciled with either.
 *
 * The browser acceptance measures the same claim where it happens -- the width
 * a table is actually given -- and this test is the fast half: it fails in the
 * unit suite, with the number that has to change, instead of in a browser run
 * an hour later.
 */

/**
 * The content column a list table is given at a 1440px viewport.
 *
 * The arithmetic is the shell's own: the navigation is 256px wide once the
 * viewport is at least 1280px (`w-64`), the page body has 32px of padding on
 * each side (`xl:p-8`), and the table's own region has a 1px border on each
 * side. 1440 - 256 - 64 - 2 = 1118.
 */
const CONTENT_COLUMN_AT_1440 = 1118;

interface Row {
  readonly id: string;
}

test("a table's declared width is the sum of its column weights", () => {
  // The number the acceptance measures is this number: the table tells the
  // browser how wide it wants to be, and the browser gives it that width or
  // the container's, whichever is larger.
  const columns: readonly ColumnDef<Row>[] = [
    { id: "role", header: "Role", weight: 215, cell: (row) => row.id },
    { id: "model", header: "Model", weight: 185, cell: (row) => row.id },
    { id: "state", header: "State", weight: 147, cell: (row) => row.id }
  ];
  const markup = renderToStaticMarkup(
    React.createElement(DataTable<Row>, {
      data: [{ id: "orchestrator" }],
      columns,
      keyExtractor: (row) => row.id,
      emptyMessage: "No rows."
    })
  );

  assert.match(
    markup,
    /min-width:\s*547px/u,
    "the table's minimum width is the sum of the column weights"
  );
});

function sourceOf(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/**
 * The columns a view declares, and the budget they add up to.
 *
 * The slice is the view's own column list, so a weight belonging to another
 * table in the same file -- the providers page has a second one for its model
 * catalogue -- is not counted here.
 */
function declaredBudget(
  relativePath: string,
  from: string,
  to: string
): { readonly total: number; readonly weights: readonly number[] } {
  const source = sourceOf(relativePath);
  const start = source.indexOf(from);
  assert.notEqual(
    start,
    -1,
    `${relativePath} no longer declares its columns where this test looks ` +
      `for them ("${from}"). The columns moved: update this test to the new ` +
      "place rather than deleting the check."
  );
  const end = source.indexOf(to, start);
  assert.notEqual(
    end,
    -1,
    `${relativePath} no longer ends its column list where this test looks ` +
      `for it ("${to}"). Update this test to the new place rather than ` +
      "deleting the check."
  );
  const slice = source.slice(start, end);
  const weights = Array.from(slice.matchAll(/weight:\s*(\d+)/gu), (match) =>
    Number(match[1])
  );
  assert.notEqual(
    weights.length,
    0,
    `${relativePath} declares no column weights in the slice this test reads`
  );
  return { total: weights.reduce((sum, weight) => sum + weight, 0), weights };
}

const VIEWS = [
  {
    name: "the agents table",
    path: "../src/features/agents/AgentsView.ts",
    from: "const columns: ColumnDef<AgentDefinition>[] = [",
    to: "\n  ];"
  },
  {
    name: "the providers table",
    path: "../src/features/providers/ProvidersView.ts",
    from: "function providerColumns(",
    to: "function modelColumns("
  },
  {
    name: "the MCPs table",
    path: "../src/features/mcps/McpsView.ts",
    from: "const columns: ColumnDef<McpServerResource>[] = [",
    to: "\n  ];"
  },
  {
    name: "the workspaces table",
    path: "../src/features/workspaces/WorkspacesView.ts",
    from: "const columns: ColumnDef<ControlApiWorkspaceRecord>[] = [",
    to: "\n  ];"
  }
] as const;

for (const view of VIEWS) {
  test(`${view.name} declares a budget that fits the content column`, () => {
    const { total, weights } = declaredBudget(view.path, view.from, view.to);

    assert.ok(
      total <= CONTENT_COLUMN_AT_1440,
      `${view.name} declares a budget of ${String(total)}px ` +
        `(${weights.join(" + ")}) against a ${String(CONTENT_COLUMN_AT_1440)}px ` +
        "content column, so its last column is off the page. Narrow a column " +
        "that has slack, or narrow the content it does not need."
    );
  });
}
