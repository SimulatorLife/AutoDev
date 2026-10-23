import type { RuleSyncValidationIssue } from "../validation/types.ts";

/**
 * The canonical hook events Codex runs.
 *
 * RuleSync's canonical vocabulary is wider than this: it names an event for
 * every tool it can project to, and it silently skips the ones a given target
 * does not support. The AutoDev runtime installs one projection, the Codex
 * one, so an event Codex does not run is a declaration the Runtime cannot
 * apply and the Console has nothing to show for it. The list is therefore the
 * events Codex runs, which is the set the Runtime can actually install.
 *
 * `sessionEnd` is here because Codex runs it and the canonical declaration
 * declares it for the `codexcli` target; a contract that left it out could
 * not describe the hooks AutoDev installs.
 */
export type HookEvent =
  | "sessionStart"
  | "sessionEnd"
  | "preToolUse"
  | "postToolUse"
  | "beforeSubmitPrompt"
  | "stop"
  | "stopCancelled"
  | "permissionRequest"
  | "subagentStart"
  | "subagentStop"
  | "preCompact"
  | "postCompact";

/**
 * The same events, as a list.
 *
 * The union above is the type; this is the runtime set, and the two are
 * declared together so a caller can check an event name without restating
 * the vocabulary. A guard that listed its own events would drift from the type
 * it narrows, and the drift would be invisible until a declaration carried an
 * event one of the two had never heard of.
 */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "sessionStart",
  "sessionEnd",
  "preToolUse",
  "postToolUse",
  "beforeSubmitPrompt",
  "stop",
  "stopCancelled",
  "permissionRequest",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "postCompact"
];

/**
 * Whether a name is a hook event the Runtime can install.
 *
 * A name that is not one is not silently dropped: the loader that calls this
 * says why, because a declaration the console cannot describe is a
 * declaration the operator cannot act on.
 */
export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

export interface HookAction {
  readonly type: "command";
  readonly command: string;
  readonly matcher?: string;
  readonly statusMessage?: string;
}

/**
 * One hook event, as one target receives it.
 *
 * The origin says where the declaration of the event lives, which is what
 * decides who else an edit reaches: a shared event reaches every target and a
 * target's own event reaches one.
 */
export interface HookDefinition {
  readonly event: HookEvent;
  readonly origin: HookDeclarationOrigin;
  readonly actions: readonly HookAction[];
}

/**
 * Where a target's declaration of an event comes from.
 *
 * RuleSync merges the shared declaration with the target's own declaration
 * one event at a time, so an event is either declared for every target or
 * declared for this one alone. The origin is published because it is the
 * difference between an edit that reaches every target and an edit that
 * reaches one, and an operator cannot tell them apart from the value alone.
 */
export type HookDeclarationOrigin = "shared" | "target";

/**
 * One event, as one target's declaration gives it.
 *
 * The actions are the whole list the event runs, not a delta: RuleSync
 * replaces an event's action list when a target declares that event, so a
 * partial list would be read as the whole list and would drop the actions it
 * left out.
 */
export interface HookEventDeclaration {
  readonly event: HookEvent;
  /**
   * Where this target's declaration of the event comes from.
   *
   * `shared` means every target inherits it; `target` means this target
   * declares it alone. It is published because it decides who else an edit
   * reaches, and the value alone does not say.
   */
  readonly origin: HookDeclarationOrigin;
  readonly actions: readonly HookAction[];
}

/**
 * The canonical hook declaration, read for one target.
 *
 * `events` is the target's effective declaration: the shared declaration with
 * the target's own declaration merged over it, one event at a time, which is
 * how RuleSync merges them. A target's own declaration of an event replaces
 * the shared one for that event rather than adding to it.
 */
export interface RuleSyncHooksState {
  readonly source: ".rulesync/hooks.jsonc";
  readonly valid: boolean | null;
  /**
   * Why the source is invalid; empty when it is valid or was not observed.
   *
   * Required rather than optional so that a caller cannot read `valid: false`
   * and conclude there is nothing more to say. The loader knows which event
   * failed and what the parser objected to; reporting only the boolean made an
   * operator hunt through the file for a fault the system had already located.
   */
  readonly issues: readonly RuleSyncValidationIssue[];
  /** The target whose effective declaration this is. */
  readonly target: string;
  readonly events: readonly HookEventDeclaration[];
}
