import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type ColumnDef,
  DataTable
} from "../src/components/tables/DataTable.ts";

/**
 * A table that is wider than the viewport scrolls inside its own region, and a
 * region that scrolls has to be reachable by keyboard.
 *
 * The permission matrix was the case that needed it: its cells hold no links
 * and no controls, so nothing inside could be focused and the region was not
 * focusable either. Its right-hand columns were reachable with a pointer and
 * by nothing else, which is the same as unreachable for a keyboard operator.
 *
 * The region is focusable, so the arrow keys scroll it, and it is named, so a
 * screen reader says which table it is rather than "region".
 */
interface Row {
  readonly id: string;
}

const COLUMNS: readonly ColumnDef<Row>[] = [
  {
    id: "role",
    header: "Role",
    cell: (row) => row.id
  },
  {
    id: "capability",
    header: "Capability",
    cell: (row) => row.id
  }
];

function regionOf(markup: string): string {
  const region = /<div[^>]*role="region"[^>]*>/u.exec(markup)?.[0];
  assert.notEqual(region, undefined, "the table scrolls inside a named region");
  return region!;
}

test("the table's scroll region is reachable by keyboard", () => {
  const markup = renderToStaticMarkup(
    React.createElement(DataTable<Row>, {
      data: [{ id: "smart" }],
      columns: COLUMNS,
      keyExtractor: (row) => row.id,
      emptyMessage: "No role capability matrices were observed."
    })
  );

  const region = regionOf(markup);
  assert.match(
    region,
    /tabindex="0"/u,
    "a region that scrolls has to be focusable, or its right-hand columns are unreachable"
  );
  assert.match(
    region,
    /aria-label="Role, Capability"/u,
    "the region is named after the table it holds"
  );
});

test("a view can name the region better than its columns do", () => {
  const markup = renderToStaticMarkup(
    React.createElement(DataTable<Row>, {
      data: [{ id: "smart" }],
      columns: COLUMNS,
      keyExtractor: (row) => row.id,
      emptyMessage: "No role capability matrices were observed.",
      label: "Effective role capability matrix"
    })
  );

  const region = regionOf(markup);
  assert.match(
    region,
    /aria-label="Effective role capability matrix"/u,
    "the view knows what its table is called; the region says so"
  );
  assert.match(region, /tabindex="0"/u);
});
