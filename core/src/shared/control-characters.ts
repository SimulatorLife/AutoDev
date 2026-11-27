/**
The one owner of "this single-line text carries a control character".

Operator- and model-supplied identifiers, reasons and paths cross the
Console, the Control API, the Runtime and the Workspaces records, and each
boundary refuses a value that carries a C0 control character (U+0000 to
U+001F) or DEL (U+007F): such a value can forge a log line, split a header,
or name a different file than the one the operator read. Every boundary
used to spell that check for itself; this is the one spelling.

Line breaks and tabs are control characters too, so this refuses them. A
multi-line field that admits them owns its own, wider rule.
*/
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
