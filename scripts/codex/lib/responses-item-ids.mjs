/**
 * Enforcing the Responses API's item-id contract on replayed history.
 *
 * Every item in a Responses request carries an `id` whose prefix encodes its
 * type: a `reasoning` item's id begins `rs_`, a `custom_tool_call`'s begins
 * `ctc_`, and so on. OpenAI validates that prefix against the item's type and
 * rejects the whole request when they disagree:
 *
 *   Invalid 'input[18].id': '06ef3bc08924acade1facee14da0af2e_fc_0'.
 *   Expected an ID that begins with 'ctc'.
 *
 * Not every provider behind this router honours that contract. MiniMax mints
 * ids shaped `<32 hex>_rs` and `<32 hex>_fc_<n>`, and the MiniMax proxy's
 * freeform coercion additionally retypes a `function_call` as a
 * `custom_tool_call` while keeping the id it arrived with. Codex persists
 * whatever it is handed and replays it on every subsequent turn, so one turn
 * served by a lax provider permanently poisons a session: the next turn that
 * lands on a strict provider fails, and so does every turn after it, because
 * the history only ever grows.
 *
 * Normalising here rather than in a provider adapter is what makes the repair
 * retroactive. Rollout files on disk are immutable, but every turn is re-sent
 * through the router, so rewriting on the way out heals sessions that are
 * already poisoned without touching a single stored byte.
 */

import { createHash } from "node:crypto";

/**
 * The prefix each item type's id must carry.
 *
 * Deliberately partial: only types whose prefix is corroborated by observed
 * traffic are listed, and an item of any other type is passed through
 * untouched. Guessing a prefix would turn an id the upstream accepts into one
 * it does not.
 */
export const RESPONSES_ITEM_ID_PREFIXES = Object.freeze({
  message: "msg_",
  reasoning: "rs_",
  function_call: "fc_",
  custom_tool_call: "ctc_",
  function_call_output: "fco_",
  custom_tool_call_output: "ctco_",
});

/**
 * Types whose items carry everything the upstream needs to interpret them.
 *
 * `reasoning` is deliberately absent. A reasoning item is the one kind that is
 * not self-contained: unless it carries `encrypted_content` it is a *reference*
 * to an item the backend stored, so a well-formed id the backend never issued
 * does not repair it -- it only moves the failure from a 400 to
 *
 *   Item with id 'rs_...' not found. Items are not persisted when `store` is
 *   set to false. Try again with `store` set to true, or remove this item from
 *   your input.
 *
 * Removing it from the input, as that error itself advises, is what
 * `dropUnresolvableReasoning` does. Rewriting the id of a reasoning item would
 * also cost real continuity on the provider that *did* produce it, which reads
 * those ids back on the next turn of its own conversation.
 */
const SELF_CONTAINED_ITEM_TYPES = Object.freeze([
  "message",
  "function_call",
  "custom_tool_call",
  "function_call_output",
  "custom_tool_call_output",
]);

/**
 * A conforming id for this item, or null when there is nothing to change.
 *
 * The replacement is a hash of the original rather than a random or counter
 * value because the same item is re-sent on every turn of a session. A value
 * that moved between turns would change the serialised request prefix each
 * time and defeat upstream prompt caching, which is precisely the cost this
 * router exists to avoid. Hashing also keeps distinct originals distinct, so
 * two items can never collapse onto one id.
 */
export function normalizeItemId(type, id) {
  if (!SELF_CONTAINED_ITEM_TYPES.includes(type)) return null;
  const prefix = RESPONSES_ITEM_ID_PREFIXES[type];
  if (!prefix) return null;
  // An absent id is legal -- Codex omits it on some tool outputs -- and an
  // invented one would name an item the upstream never issued.
  if (typeof id !== "string" || !id) return null;
  if (id.startsWith(prefix)) return null;
  return `${prefix}${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/**
 * The same input with every non-conforming item id rewritten.
 *
 * `call_id` is never touched. Tool calls and their outputs are paired by that
 * field, the values providers mint for it are accepted upstream as they are,
 * and rewriting one side of a pair would strand the other.
 *
 * Returns the original array when nothing changed, so the ordinary case --
 * every id already well-formed -- allocates nothing.
 */
export function normalizeInputItemIds(input) {
  if (!Array.isArray(input)) return { input, changed: 0 };
  let changed = 0;
  const normalized = input.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const id = normalizeItemId(item.type, item.id);
    if (id === null) return item;
    changed += 1;
    return { ...item, id };
  });
  return changed ? { input: normalized, changed } : { input, changed: 0 };
}

/**
 * The same input without the reasoning items this upstream cannot resolve.
 *
 * A reasoning item carrying `encrypted_content` is self-describing: the backend
 * decrypts it and needs to look nothing up. One without it names an item the
 * backend is expected to already hold, and Codex runs with `store: false`, so
 * for anything the backend did not itself produce there is nothing to find --
 * a 404 that ends the turn.
 *
 * The two are cleanly separable in practice. Every genuine OpenAI reasoning
 * item observed carries encrypted content; the ones that do not are all
 * synthetic -- MiniMax's own traces, and the activity summaries the CLI bridges
 * mint so a bridge-served turn still shows its thinking in the app. None of
 * that is intelligible to a different backend anyway, so dropping it costs
 * nothing beyond a summary the model never authored.
 *
 * This is why it is not applied to every route: on the provider that minted
 * them, those same items are live reasoning continuity.
 */
export function dropUnresolvableReasoning(input) {
  if (!Array.isArray(input)) return { input, dropped: 0 };
  const kept = input.filter((item) => {
    if (item === null || typeof item !== "object" || item.type !== "reasoning") return true;
    return typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
  });
  const dropped = input.length - kept.length;
  return dropped ? { input: kept, dropped } : { input, dropped: 0 };
}
