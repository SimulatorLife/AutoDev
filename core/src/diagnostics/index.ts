/**
The unified session diagnostics contract and its text rendering.

`@simulatorlife/autodev-core` owns the shape of the evidence and the words
that describe it; `@simulatorlife/autodev-data/diagnostics` owns the reading
of it. Every consumer -- the Console, the CLI, the skill wrapper -- speaks
this shape.
*/

export * from "./acp-pins.ts";
export * from "./client-surface.ts";
export * from "./format.ts";
export * from "./types.ts";
