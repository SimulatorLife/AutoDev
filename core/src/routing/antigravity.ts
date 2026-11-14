/**
 * The providers the one Antigravity service (the `agy` CLI behind its bridge)
 * serves.
 *
 * AutoDev routes agy's Gemini, Argon, and effort-suffixed Claude/GPT-OSS model
 * families separately so each route owns its model set and reactive cooldowns.
 * This route partition is not a quota identity: quota-axi reports the service
 * as `agy`. The Console preserves that identity and shows the shared usage
 * beneath each route served by this service without rewriting the report.
 * The Runtime owns which model ids each route serves
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
