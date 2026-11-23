import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * The marketplace that ships OpenAI's own bundled Codex plugins.
 *
 * Every plugin in it carries a native Codex surface - browser control,
 * computer use, the CUA REPL - that AutoDev does not expose to agents.
 */
export const BUNDLED_MARKETPLACE = "openai-bundled";

/**
 * The suffix Codex writes after the plugin name in a `[plugins]` key:
 * `<plugin>@<marketplace>`.
 */
export const BUNDLED_PLUGIN_KEY_SUFFIX = `@${BUNDLED_MARKETPLACE}`;

const COLLATOR = new Intl.Collator();

/**
 * The bundled OpenAI plugins Codex has installed under its plugin cache.
 *
 * Codex installs a plugin into `$CODEX_HOME/plugins/cache/<marketplace>/`
 * and leaves it enabled unless the user's config names it as disabled. A
 * plugin OpenAI ships and Codex auto-installs is therefore live for every
 * agent until the config says otherwise, and an install is the only moment
 * AutoDev can name it. The portable source names the bundled plugins AutoDev
 * allows; the composer needs the installed set to name the rest.
 */
export function listBundledPlugins(codexHome: string): string[] {
  const cacheRoot = path.join(
    codexHome,
    "plugins",
    "cache",
    BUNDLED_MARKETPLACE
  );
  try {
    return readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => COLLATOR.compare(left, right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
