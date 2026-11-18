import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ToolCatalogItem } from "@simulatorlife/autodev-core";

import {
  findToolById,
  qualifiedToolName,
  toolId
} from "../src/features/tools/index.ts";

/**
 * The Tools catalogue has one address, and one entrypoint.
 *
 * The list page and the detail page used to reach into the catalogue's
 * modules by path and between them re-derived the rule for what a tool's
 * address is: the detail page matched the URL against three spellings of an
 * entry's name while the list wrote one. A page that resolves an address by a
 * rule the catalogue does not own answers a question nobody asked, so the
 * lookup now lives next to the id it resolves and both pages ask the
 * catalogue for it.
 */

const NATIVE_TOOL: ToolCatalogItem = {
  name: "read_file",
  source: "native",
  sourceAuthority: "codex-native",
  exposedRoles: ["worker"],
  availability: "configured"
};

const MCP_TOOL: ToolCatalogItem = {
  name: "lsp_goto_definition",
  source: "mcp",
  sourceAuthority: "rulesync-mcp",
  server: "lsp",
  exposedRoles: ["worker"],
  availability: "configured"
};

const CATALOGUE: readonly ToolCatalogItem[] = [NATIVE_TOOL, MCP_TOOL];

test("the id the list writes is the id the catalogue resolves", () => {
  for (const tool of CATALOGUE) {
    assert.equal(
      findToolById(CATALOGUE, toolId(tool)),
      tool,
      tool.name + " must resolve by the id the list links to"
    );
  }
});

test("an id round-trips through the wire name it addresses", () => {
  // The route hands over a path segment, which arrives encoded or decoded
  // depending on who built the address. Both spellings of the id the Console
  // writes address the same entry.
  for (const tool of CATALOGUE) {
    const wireName = qualifiedToolName(tool);
    assert.equal(findToolById(CATALOGUE, wireName), tool);
    assert.equal(findToolById(CATALOGUE, encodeURIComponent(wireName)), tool);
  }
});

test("an id the catalogue does not hold resolves to nothing", () => {
  assert.equal(
    findToolById(CATALOGUE, "mcp__other__lsp_goto_definition"),
    undefined
  );
  assert.equal(findToolById(CATALOGUE, "not_a_tool"), undefined);
  assert.equal(findToolById(CATALOGUE, ""), undefined);
});

test("an address the Console never writes addresses nothing", () => {
  // The Console writes one id per entry: the qualified wire name. The other
  // spellings the detail page used to accept -- the bare name of an MCP tool,
  // the source-qualified "source:server:name", and the "mcp____name" a
  // server-less tool would take -- were never written by anything, so
  // resolving them answered a question the Console had not asked.
  assert.equal(findToolById(CATALOGUE, "lsp_goto_definition"), undefined);
  assert.equal(
    findToolById(CATALOGUE, "mcp:lsp:lsp_goto_definition"),
    undefined
  );
  assert.equal(findToolById(CATALOGUE, "mcp____read_file"), undefined);
});

test("the Tools pages reach the catalogue through its entrypoint", () => {
  const pages = [
    new URL("../app/tools/page.tsx", import.meta.url),
    new URL("../app/tools/[name]/page.tsx", import.meta.url)
  ];
  for (const page of pages) {
    const source = readFileSync(page, "utf8");
    assert.match(
      source,
      /from\s+["'][^"']*src\/features\/tools\/index\.ts["']/u,
      page.pathname + " must import the catalogue through its entrypoint"
    );
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*src\/features\/tools\/(?!index\.ts)["']/u,
      page.pathname +
        " must not reach past the entrypoint into the catalogue's modules"
    );
  }
});
