/**
 * Which provider issued each tool call, so its result goes back to it.
 *
 * Codex drives a turn as a loop of requests, and the router picks a provider
 * per request. Without affinity, the request that carries a tool's output can
 * land on a different provider from the one that asked for it -- a turn that
 * hops providers mid-step, each one continuing work it did not start. For a
 * provider that keeps turn state between requests (the Claude bridge parks its
 * CLI on the call) the hop also strands that state until it times out.
 *
 * The router sees every call a provider emits on the way out, so it records
 * the call id against the provider, and a request whose input ends in outputs
 * for those calls prefers that provider (see src/shared/responses-continuation.ts
 * for which results count as awaited). It is a preference, not a pin: a
 * provider that is disabled or cooling down is skipped like any other, and
 * the next provider continues from the replayed history.
 */

import { awaitedToolResults } from '../shared/responses-continuation.ts';

const DEFAULT_LIMIT = 4096;

/** Call ids of the tool results a request hands back: the calls the model awaits. */
export function awaitedCallIds(payload: unknown): string[] {
  const input = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as { input?: unknown }).input : undefined;
  return [ ...awaitedToolResults(input).outputs.keys() ];
}

export class ToolCallOwnership {
  private readonly owners = new Map<string, string>();
  private readonly limit: number;

  constructor(limit = DEFAULT_LIMIT) {
    this.limit = limit;
  }

  record(callIds: Iterable<string>, provider: string): void {
    for (const callId of callIds) {
      this.owners.delete(callId);
      this.owners.set(callId, provider);
    }
    // Bounded, oldest first: a call's result comes back within its own turn.
    while (this.owners.size > this.limit) {
      const oldest = this.owners.keys().next().value;
      if (oldest === undefined) break;
      this.owners.delete(oldest);
    }
  }

  /** The provider whose calls this request's trailing tool results answer. */
  ownerFor(payload: unknown): string | null {
    for (const callId of awaitedCallIds(payload)) {
      const owner = this.owners.get(callId);
      if (owner) return owner;
    }
    return null;
  }

  clear(): void {
    this.owners.clear();
  }
}

export const TOOL_CALL_OWNERSHIP = new ToolCallOwnership();
