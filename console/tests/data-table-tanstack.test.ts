import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { type ColumnDef } from "@tanstack/react-table";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DataTable,
  type DataTableFeatures
} from "../src/components/tables/DataTable.ts";

interface Row {
  readonly id: string;
  readonly name: string;
}

const ROWS: readonly Row[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" }
];

function render(columns: readonly ColumnDef<DataTableFeatures, Row>[]): string {
  return renderToStaticMarkup(
    React.createElement(DataTable<Row>, {
      data: ROWS,
      columns,
      keyExtractor: (row) => row.id,
      emptyMessage: "No rows."
    })
  );
}

test("DataTable builds its rows and columns with TanStack's constructTable and stays hook-free", () => {
  // Comments may name the hooks to explain their absence; only code counts.
  const source = readFileSync(
    new URL("../src/components/tables/DataTable.ts", import.meta.url),
    "utf8"
  )
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
    .join("\n");
  assert.match(source, /from "@tanstack\/react-table"/u);
  assert.match(source, /\bconstructTable\b/u);
  assert.match(source, /\btableFeatures\b/u);
  assert.match(source, /\bflexRender\b/u);
  assert.doesNotMatch(source, /\buseTable\b/u);
  assert.doesNotMatch(source, /\buseReactTable\b/u);
  assert.doesNotMatch(source, /["']use client["']/u);
  assert.doesNotMatch(source, /\buse(State|Memo|Effect|Ref|Callback)\b/u);
  assert.doesNotMatch(
    source,
    /export (interface|type) ColumnDef\b/u,
    "the Console has no column model of its own; TanStack's ColumnDef is the only one"
  );
});

test("DataTable hands each cell TanStack's context, with the keyExtractor as the row id", () => {
  const html = render([
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => row.original.name,
      meta: { rowHeader: true }
    },
    { id: "key", header: "Key", cell: ({ row }) => "key:" + row.id }
  ]);
  assert.match(html, />Alpha</u);
  assert.match(html, /<th scope="row"[^>]*>Alpha<\/th>/u);
  assert.match(html, />key:a</u);
  assert.match(html, />key:b</u);
});

test("DataTable resolves column weights from TanStack meta and the last column absorbs rounding", () => {
  const html = render([
    { id: "one", header: "One", cell: () => "x", meta: { weight: 100 } },
    { id: "two", header: "Two", cell: () => "x", meta: { weight: 100 } },
    { id: "three", header: "Three", cell: () => "x", meta: { weight: 100 } }
  ]);
  assert.match(html, /min-width:300px/u);
  const widths = Array.from(
    html.matchAll(/<th[^>]*style="width:([\d.]+)%"/gu),
    (match) => Number(match[1])
  );
  assert.deepEqual(widths, [33.33, 33.33, 33.34]);
});

test("DataTable carries header help from meta onto the marker and the label group", () => {
  const html = render([
    {
      id: "state",
      header: "State",
      cell: () => "x",
      meta: { headerHelp: "What it means" }
    }
  ]);
  assert.match(html, /data-column-header="state"/u);
  assert.match(html, /data-column-label="state"/u);
  assert.match(html, /data-column-help="state"/u);
  assert.match(html, /aria-label="State: What it means"/u);
});

test("DataTable refuses a column whose header is not text", () => {
  assert.throws(
    () => render([{ id: "bad", header: () => "Bad", cell: () => "x" }]),
    /needs a string header/u
  );
});
