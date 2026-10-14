/**
 * What every bridge that parks Codex tool calls shares.
 *
 * A bridged provider cannot run Codex's tools itself: the CLI or CLI-like
 * process has no sandbox, no approvals, and no place in the thread history. So
 * a provider calls a tool through the MCP shim
 * (`runtime/src/mcp/codex-tools-shim.ts`), the shim blocks on a loopback call
 * into the bridge, the bridge emits the call as a Responses output item, and
 * Codex executes it. The response ends there; the call's output comes back on
 * Codex's next request and releases the parked call.
 *
 * This module owns the parts of that which are not specific to one provider:
 * the live-turn registry that maps a shim call back to the turn holding it, and
 * the two shapes both sides need to agree on. The Claude and Antigravity
 * bridges each keep their own turn class, because their streams and process
 * lifecycles differ.
 */

import { randomBytes } from "node:crypto";

type JsonRecord = Record<string, unknown>;

/** The minimum a parked turn must offer to live in the registry. */
export interface ParkableTurn {
  readonly id: string;
  cancel(): void;
}

/** A short random id, for turn ids and output-item ids alike. */
export function turnId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** The MCP `tools/call` result for a call that could not be made. */
export function toolErrorResult(text: string): JsonRecord {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * The live turns a bridge is holding, and which turn owns each parked call.
 *
 * The shim names its turn in every loopback call, and the router names a call's
 * owner only through the `call_id` Codex returns the output against, so the
 * registry is what joins the two halves of a parked turn back together.
 */
export class CodexToolTurnRegistry<T extends ParkableTurn> {
  private readonly turns = new Map<string, T>();
  private readonly calls = new Map<string, T>();
  private readonly maxTurns: number;

  constructor(maxTurns = 32) {
    this.maxTurns = maxTurns;
  }

  add(turn: T): void {
    // Bounded: an abandoned turn is reclaimed by its park timer, and this cap
    // keeps a burst of them from holding unbounded provider processes meanwhile.
    while (this.turns.size >= this.maxTurns) {
      const oldest = this.turns.values().next().value;
      if (!oldest) break;
      oldest.cancel();
    }
    this.turns.set(turn.id, turn);
  }

  bindCall(callId: string, turn: T): void {
    this.calls.set(callId, turn);
  }

  byId(id: string): T | null {
    return this.turns.get(id) ?? null;
  }

  /** The turn waiting on any of these call outputs, if one is still alive. */
  forOutputs(outputs: Map<string, unknown>): T | null {
    for (const callId of outputs.keys()) {
      const turn = this.calls.get(callId);
      if (turn) return turn;
    }
    return null;
  }

  /** Cancel every live turn, killing its process. Returns how many there were. */
  cancelAll(): number {
    const live = [...this.turns.values()];
    for (const turn of live) turn.cancel();
    return live.length;
  }

  remove(turn: T): void {
    this.turns.delete(turn.id);
    for (const [callId, owner] of this.calls)
      if (owner === turn) this.calls.delete(callId);
  }

  status(): { turns: number; maxTurns: number } {
    return { turns: this.turns.size, maxTurns: this.maxTurns };
  }
}