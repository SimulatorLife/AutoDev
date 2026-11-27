/**
The Tools catalogue contract, as one schema.

The Runtime produces this response and the Console reads it. The Console
used to hold the contract as two hand-written guards beside a hand-written
interface in Core that nothing validated against. One schema, owned here, is
now the only statement of the envelope -- the producer names its schema id,
the reader validates against it, and the response type is read out of it.
*/
import { z } from "zod";

import type {
  ToolCatalogCoverage,
  ToolCatalogItem,
  ToolCatalogValidity
} from "../tools/types.ts";

/**
The contract revision the Runtime and the Console must agree on.
*/
export const CONTROL_API_TOOLS_SCHEMA_ID = "autodev-control-tools-v2" as const;

const TOOL_CATALOG_COVERAGES = [
  "complete",
  "partial",
  "unavailable",
  "unknown"
] as const satisfies readonly ToolCatalogCoverage[];

const TOOL_CATALOG_VALIDITIES = [
  "valid",
  "invalid",
  "not-observed"
] as const satisfies readonly ToolCatalogValidity[];

/**
One catalogue row, checked for the members every view reads off it.

Role exposure drives both the role filter (`exposedRoles.includes`) and the
role chips (`exposedRoles.length`), and the availability verdict is what
separates "configured" from "Not observed", so a row missing any of them
would reach the view and throw instead of failing closed.

The row is a loose object on purpose. Its type is `ToolCatalogItem`, which
the data and Runtime producers own in `tools/types.ts`; the schema checks
the members a reader depends on and passes the rest through, rather than
restating that type here as a second spelling of it.
*/
export const toolCatalogRowSchema = z.looseObject({
  name: z.string(),
  source: z.string(),
  sourceAuthority: z.string(),
  exposedRoles: z.array(z.string()).readonly(),
  availability: z.string()
});

/**
The whole response.
*/
export const controlApiToolsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_TOOLS_SCHEMA_ID),
    source: z.string(),
    readOnly: z.literal(true),
    coverage: z.enum(TOOL_CATALOG_COVERAGES),
    validity: z.enum(TOOL_CATALOG_VALIDITIES),
    /**
    Whether the execution contract was read.

    The catalogue's second half is the contract's role projection: which roles
    reach which tools. The accessor that reads the contract falls back to an
    empty contract when the read fails, so an empty contract and a contract
    nobody read look the same to a caller. They are not the same claim -- the
    first says the contract declares no roles, the second says nobody read it
    -- and every count over the catalogue, and every statement about a tool's
    role exposure, depends on which one it was.

    False when the contract could not be read. The entries that arrived are
    then the ones the RuleSync source alone declared, and the catalogue's size
    is not known. A payload that does not carry it cannot say whether the
    contract was read, so the reader refuses it.
    */
    executionContractObserved: z.boolean(),
    /**
    How many tools the composite catalogue holds.

    The catalogue is built from two independent reads -- the execution
    contract's roles and the RuleSync tool catalogue -- so the count is a
    number only when both were observed. One unread read makes the count
    incomplete rather than small, and an incomplete count is not a count.

    Null when either read was not observed. A catalogue that was read and
    holds no tools is a measured zero and stays a number: "nothing was there"
    and "nobody looked" are different claims.
    */
    totalTools: z.number().nullable(),
    tools: z.array(toolCatalogRowSchema).readonly(),
    usageLink: z.string()
  })
  .readonly();

/**
The Tools catalogue response.

The envelope is read out of the schema. The rows stay `ToolCatalogItem`,
the producers' type: the row schema checks only what a reader depends on, so
its inferred type is looser than the rows the Runtime actually produces.
*/
export type ControlApiToolsResponse = Omit<
  z.infer<typeof controlApiToolsResponseSchema>,
  "tools"
> & {
  readonly tools: readonly ToolCatalogItem[];
};

/**
Whether a value is a Tools catalogue response.

The one place the schema's verdict is read as the response type: the schema
checks every envelope member and the members of each row a reader depends
on, and the rows are the producers' `ToolCatalogItem`.
*/
export function isControlApiToolsResponse(
  value: unknown
): value is ControlApiToolsResponse {
  return controlApiToolsResponseSchema.safeParse(value).success;
}
