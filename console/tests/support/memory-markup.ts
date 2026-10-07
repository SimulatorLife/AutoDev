/**
 * Reading what a server-rendered form will actually submit.
 *
 * The Console's memory actions are plain form POSTs, and the defect class they
 * keep producing is not in the request — it is in the form. A button that looks
 * wired, a route that builds a body the Runtime accepts, and no control
 * collecting a field it refuses is a refusal an operator can never avoid, and
 * nothing in either package sees it.
 *
 * So these tests read the markup: which `<form>` a given button submits, what
 * that form will send, and what each select offers. Parsing strings rather than
 * mounting a DOM is deliberate — the Console ships no client JavaScript, so the
 * markup *is* the contract, and there is no behaviour for a browser to add.
 *
 * One copy, because three files grew their own. A helper that finds options in
 * one form and the same helper that finds options in a whole page are the same
 * function, and three subtly different copies of "what does this select offer"
 * is three answers to one question.
 */

import assert from "node:assert/strict";

/**
 * The `<form>` that submits through the button carrying this test id.
 *
 * Scoped by the button rather than by position, so a test states which action
 * it is about. Buttons are marked with `data-button`; the form opens before its
 * button and closes after it.
 */
export function actionForm(markup: string, testId: string): string {
  const button = markup.indexOf(`data-button="${testId}"`);
  assert.notEqual(button, -1, `no action button rendered for ${testId}`);
  const open = markup.lastIndexOf("<form", button);
  const close = markup.indexOf("</form>", button);
  assert.ok(open !== -1 && close > open, `${testId} is not inside a form`);
  return markup.slice(open, close);
}

/** The `name` of every control in a form, in document order. */
export function fieldNames(form: string): string[] {
  return [...form.matchAll(/<(?:input|select|textarea)\b[^>]*>/gu)]
    .map((match) => /\bname="([^"]*)"/u.exec(match[0])?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * What one control will submit.
 *
 * The three element kinds keep their value in three places, and reading them
 * uniformly is the whole point: an `input` has a `value` attribute, a
 * `textarea` holds its text, and a `select` submits whichever `option` is
 * chosen. Treating all three as "look for a `value` attribute" makes a textarea
 * read as empty, and — worse — makes a select's first option's value leak in as
 * the control's, which is the kind of wrong answer that makes an assertion
 * pass for the wrong reason.
 *
 * `scope` is any markup: a form, or a whole page when the control is not inside
 * one of the forms under test.
 */
export function fieldValue(scope: string, name: string): string | undefined {
  const tag = new RegExp(
    `<(input|textarea|select)\\b[^>]*\\bname="${name}"[^>]*>`,
    "u"
  ).exec(scope);
  if (!tag) return undefined;
  if (tag[1] === "select") {
    const body = scope.slice(tag.index, scope.indexOf("</select>", tag.index));
    return /<option[^>]*\bvalue="([^"]*)"/u.exec(body)?.[1] ?? "";
  }
  if (tag[1] === "textarea") {
    // A textarea's value is its text, not an attribute; React escapes it on the
    // way out, so it has to be read back the way it will arrive on submit.
    const text = scope.slice(
      tag.index + tag[0].length,
      scope.indexOf("</textarea>", tag.index)
    );
    return text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#x27;", "'")
      .replaceAll("&amp;", "&");
  }
  return /\bvalue="([^"]*)"/u.exec(tag[0])?.[1] ?? "";
}

/** Every option a select offers, so a bounded vocabulary can be compared. */
export function selectOptions(scope: string, name: string): string[] {
  return selectEntries(scope, name).map((entry) => entry.value);
}

/** What a select offers, with the text shown beside each value. */
export function selectEntries(
  scope: string,
  name: string
): { value: string; label: string }[] {
  const open = new RegExp(`<select\\b[^>]*\\bname="${name}"[^>]*>`, "u").exec(
    scope
  );
  assert.ok(open, `no select named ${name}`);
  const body = scope.slice(open.index, scope.indexOf("</select>", open.index));
  return [...body.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</gu)].map(
    (match) => ({ value: match[1]!, label: match[2]! })
  );
}

/**
 * Every control with this name anywhere in the markup, each one's options.
 *
 * For the question "can these two selects of the same vocabulary disagree?",
 * which one select per page cannot ask.
 */
export function allOptions(
  markup: string,
  name: string
): { value: string; label: string }[][] {
  return [...markup.matchAll(new RegExp(`<select\\b[^>]*name="${name}"[^>]*>`, "gu"))]
    .map((match) => {
      const body = markup.slice(
        match.index,
        markup.indexOf("</select>", match.index)
      );
      return [...body.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</gu)].map(
        (option) => ({ value: option[1]!, label: option[2]! })
      );
    });
}