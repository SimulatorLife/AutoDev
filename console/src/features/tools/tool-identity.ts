import type { ToolCatalogItem } from "@simulatorlife/autodev-core";

/**
The MCP wire name for a catalog entry.

The catalog keeps `source`, `server` and `name` as three fields and keys
entries on all three, so the joined `mcp__<server>__<name>` form is a
composition, not a field. It was being assembled independently in four
places -- the URL id, the Usage identity list, the list cell and the detail
page -- which is how the list cell came to print
`mcp__codegraphcontext__analyze_code_relationships` beside a Source column
already reading `mcp (codegraphcontext)`, and how the detail page came to
match an address against three spellings of an entry's name where the list
wrote exactly one. The composition and the id that carries it are assembled
here now, and the page asks for the entry rather than deriving it.
*/
export function qualifiedToolName(tool: ToolCatalogItem): string {
  return tool.server ? `mcp__${tool.server}__${tool.name}` : tool.name;
}

/**
Stable URL id for a Tools catalog entry. The Console list and detail
pages share this id so URL-addressable navigation stays stable across
both source and role filter changes.
*/
export function toolId(tool: ToolCatalogItem): string {
  return encodeURIComponent(qualifiedToolName(tool));
}

/**
The id a URL carries, read back into the wire name it addresses.

The route hands over a path segment, and a segment is text: a malformed
escape is not a name the catalogue could hold, and a name that happens to
contain a percent sign is not a malformed escape. So the decode falls back
to the segment itself rather than throwing away the address.
*/
function decodeToolId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/**
The catalogue entry a URL id addresses.

The id is the one the Console itself writes: the tool's qualified wire
name, URL-encoded. Nothing else addresses a catalogue entry -- the list
builds every row's detail link from `toolId`, so an id the Console did not
produce is an address for an entry that was never linked, and answering it
with the nearest match would be answering a different question.

`undefined` means the catalogue does not hold that entry. The caller owns
what that means: a catalogue that was fully read says the tool does not
exist, and a catalogue that was only partly read says it could not be read.
*/
export function findToolById(
  tools: readonly ToolCatalogItem[],
  id: string
): ToolCatalogItem | undefined {
  const decoded = decodeToolId(id);
  return tools.find(
    (tool) => toolId(tool) === id || qualifiedToolName(tool) === decoded
  );
}
