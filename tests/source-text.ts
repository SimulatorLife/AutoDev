/**
 * TypeScript source as layout-free text, for tests that assert on what code says.
 *
 * Prettier owns line breaks and bracket padding, so an assertion on raw source
 * would pin formatting rather than code: collapse whitespace runs to one space
 * and drop the padding inside parentheses and square brackets. Object braces
 * keep theirs, as Prettier writes `{ key }`.
 */
export function normalizedSource(text: string): string {
  return text
    .replaceAll(/\s+/g, " ")
    .replaceAll(/([([]) /g, "$1")
    .replaceAll(/ ([)\]])/g, "$1");
}
