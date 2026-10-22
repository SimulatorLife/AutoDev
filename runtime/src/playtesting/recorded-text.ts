/**
 * The text a recorded name may carry.
 *
 * A control character is either invisible or moves the reader's eye
 * somewhere else, so it becomes a space instead of a character the analyst
 * reads as part of a name. The Runtime redacts a name when it records it
 * and the affordance proposer quotes it again when it offers a candidate,
 * so the rule has one owner rather than a copy on each side.
 */

/**
 * The text with every control character replaced by a space.
 *
 * A control character is one of the codes below the space, or the delete
 * code: none of them carry a glyph, so each one becomes the space a reader
 * would have seen had the name been typed.
 */
export function withoutControlCharacters(text: string): string {
  let cleaned = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code <= 0x1f || code === 0x7f ? " " : character;
  }
  return cleaned;
}
