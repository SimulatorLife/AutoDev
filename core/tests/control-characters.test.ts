import assert from "node:assert/strict";
import test from "node:test";

import { hasControlCharacters } from "../src/shared/control-characters.ts";

/**
 * The one owner of "this single-line text carries a control character".
 * Each boundary that accepts an identifier, a reason or a path used to spell
 * this check for itself; these tests hold the single owner to its range.
 */
test("every C0 control character and DEL is refused", () => {
  for (let code = 0; code <= 0x1f; code += 1) {
    assert.equal(hasControlCharacters(`a${String.fromCharCode(code)}b`), true, `U+${code.toString(16)}`);
  }
  assert.equal(hasControlCharacters("a\u007Fb"), true);
});

test("printable text, including non-ASCII and astral characters, is accepted", () => {
  assert.equal(hasControlCharacters(""), false);
  assert.equal(hasControlCharacters("workspace-1 ~/game/build"), false);
  assert.equal(hasControlCharacters("caf\u00E9 \u0080 \u{1F3AE}"), false);
});
