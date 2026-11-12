/**
 * The providers the one Antigravity service (the `agy` CLI behind its bridge)
 * serves.
 *
 * agy meters its model families separately -- Gemini, Argon, and Claude with
 * GPT-OSS -- each with its own 5-hour and weekly limits, so AutoDev routes each
 * as a provider of its own with its own models, cooldowns and usage. The
 * Runtime owns which model ids each serves
 * (`runtime/src/shared/provider-model-ids.ts`); the Console needs only the ids,
 * for the behaviour all three share: agy fixes a model's reasoning effort in
 * its id (`-low`, `-medium`, `-high`).
 */
export const ANTIGRAVITY_PROVIDERS = Object.freeze([
  "antigravity-gemini",
  "antigravity-argon",
  "antigravity-claude-gpt"
] as const);

export type AntigravityProvider = (typeof ANTIGRAVITY_PROVIDERS)[number];

/** Whether a provider id is one the Antigravity service serves. */
export function isAntigravityProvider(
  provider: string
): provider is AntigravityProvider {
  return (ANTIGRAVITY_PROVIDERS as readonly string[]).includes(provider);
}
