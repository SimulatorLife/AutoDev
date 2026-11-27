import type { HookDefinition } from "@simulatorlife/autodev-core";
/**
The vocabulary the hook declaration's two surfaces share.

The list presents every event's declaration at once and the event's own
page presents one of them, and the two have to say the same thing about the
same declaration: an event that is declared for every target is one fact,
and an event that is declared for one target is another. Keeping the wording
here is what makes the two surfaces one declaration in two places rather
than two.
*/

/**
The origin of one event's declaration.

It is the difference between an edit that reaches every target and an edit
that reaches one, so the page says which an event is rather than leaving
the operator to find out.
*/
export function hookOriginLabel(origin: HookDefinition["origin"]): string {
  return origin === "target"
    ? "Declared for Codex only"
    : "Declared for every target";
}
