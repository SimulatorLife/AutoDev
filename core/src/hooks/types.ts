export type HookEvent =
  "sessionStart" | "subagentStart" | "beforeSubmitPrompt" | "preToolUse";

export interface HookAction {
  readonly type: "command";
  readonly command: string;
  readonly matcher?: string;
  readonly statusMessage?: string;
}

export interface HookDefinition {
  readonly event: HookEvent;
  readonly actions: readonly HookAction[];
}
