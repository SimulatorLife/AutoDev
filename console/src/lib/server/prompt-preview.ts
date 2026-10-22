import {
  parseRuleSyncCommand,
  RuleSyncCommandValidationError
} from "@simulatorlife/autodev-data/rulesync-parser";

/**
 * How a canonical prompt source would render, before it is saved.
 *
 * The operator edits a prompt's canonical source and can only see the
 * rendered result once they have saved it, and a save rewrites the canonical
 * file, regenerates the projection and may need a restart. A preview that
 * answers "what will this look like" without writing anything removes the
 * only reason to save in order to look.
 *
 * The body is produced by Data's canonical RuleSync parser -- the same parser
 * the Runtime validates a write with -- so the preview and the save cannot
 * disagree about what the source says. A reader that stripped the front
 * matter itself would be a second front-matter reader, and the two could
 * answer differently about the same text.
 */
export interface PromptSourcePreview {
  /** Whether the canonical parser accepts this source. */
  readonly valid: boolean;
  /** The prompt body the source carries, when it is valid. */
  readonly preview: string;
  /** Why the canonical parser refused it, when it does not. */
  readonly error: string | null;
}

/**
 * The preview of a canonical prompt source.
 *
 * A source the parser refuses is reported with the parser's own reason, so
 * the operator sees the message the save would refuse it with rather than a
 * second wording of the same fault.
 */
export function previewPromptSource(
  name: string,
  content: string
): PromptSourcePreview {
  try {
    const parsed = parseRuleSyncCommand(name, content);
    return { valid: true, preview: parsed.prompt, error: null };
  } catch (error) {
    if (error instanceof RuleSyncCommandValidationError) {
      return { valid: false, preview: "", error: error.message };
    }
    throw error;
  }
}
