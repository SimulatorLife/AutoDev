import assert from "node:assert/strict";
import test from "node:test";

import type { EvidenceReference } from "@simulatorlife/autodev-core";

import {
  redactSensitiveText,
  sanitizeEvidence,
  sanitizeEvidenceReference
} from "../src/memory/privacy.ts";

/**
 * The redaction applied to a derived claim before it is persisted.
 *
 * `redactSensitiveText` had no test, and the one thing that makes a redaction
 * routine worth testing is that it redacts *the same way everywhere*. It did
 * not. `String.replace` calls a replacer as `(match, ...captures, offset,
 * string)`, so for a pattern with no capture group the parameter written as
 * "key" receives the match's **offset** — a number. That number is truthy for
 * anything past the first character, so the named branch ran and the offset was
 * interpolated:
 *
 *   "prefix text Bearer abcdefgh12345" -> "prefix text 12=[REDACTED]"
 *
 * A secret at the very start redacted correctly, so the leak was invisible in
 * the easy case. What reached memory was a phantom variable name the original
 * text never contained, and the exact position of each credential within it.
 *
 * The interesting assertion is therefore not "the token is gone" — that already
 * worked — but that the replacement is identical whatever the input's layout,
 * and identical at offset zero and everywhere else.
 */

const PEM_SECRET =
  "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----";

test("every secret form redacts to the same text wherever it appears", () => {
  // One case per pattern family, each differing only in whether the secret sits
  // at offset zero. If position ever leaks again the two sides stop matching,
  // and the failure names which family regressed.
  const cases = [
    {
      label: "bearer",
      prefix: "prefix text ",
      suffix: "",
      secret: "Bearer abcdefgh12345",
      expected: "[REDACTED]"
    },
    {
      label: "vendor key",
      prefix: "token starts with ",
      suffix: "",
      secret: "sk-abcdefghijklmnopqrstuvwx",
      expected: "[REDACTED]"
    },
    {
      label: "github token",
      prefix: "the credential was ",
      suffix: "",
      secret: "ghp_abcdefghijklmnopqrstuvwxyz0123",
      expected: "[REDACTED]"
    },
    {
      label: "keyed assignment",
      prefix: "the value was ",
      suffix: "",
      secret: "password: hunter2",
      expected: "password=[REDACTED]"
    },
    {
      label: "private key block",
      prefix: "here it is\n",
      suffix: "\nend",
      secret: PEM_SECRET,
      expected: "[REDACTED]"
    }
  ] as const;

  for (const { label, prefix, secret, expected, suffix = "" } of cases) {
    assert.equal(
      redactSensitiveText(secret),
      expected,
      `${label}: the secret was not redacted at offset zero`
    );
    assert.equal(
      redactSensitiveText(`${prefix}${secret}${suffix}`),
      `${prefix}${expected}${suffix}`,
      `${label}: redaction differs once the secret is not at offset zero`
    );
  }
});

test("a redaction never carries the position of what it removed", () => {
  // The direct form of the defect, independent of which pattern matched: no
  // digit may survive next to the marker.
  for (const text of [
    "prefix text Bearer abcdefgh12345",
    "token starts with sk-abcdefghijklmnopqrstuvwx",
    "the credential was ghp_abcdefghijklmnopqrstuvwxyz0123",
    `here it is\n${PEM_SECRET}\nend`
  ]) {
    const redacted = redactSensitiveText(text);
    assert.doesNotMatch(
      redacted,
      /\d=\[REDACTED\]/u,
      `the redaction reported a position: ${JSON.stringify(redacted)}`
    );
  }
});

test("a keyed assignment keeps the name and drops only the value", () => {
  // The one pattern with a real capture, and the reason the replacer has a
  // "named" branch at all. The name is not the secret; the value is.
  assert.equal(redactSensitiveText("password: hunter2"), "password=[REDACTED]");
  assert.equal(
    redactSensitiveText("api_key=AKIA1234567890ABCD"),
    "api_key=[REDACTED]"
  );
  assert.equal(
    redactSensitiveText("the refresh_token=abc123 and then prose"),
    "the refresh_token=[REDACTED] and then prose"
  );
});

test("text that only resembles a credential is left alone", () => {
  // The cost of a redaction that fires too eagerly is a claim nobody can trust,
  // so the negative case is part of the contract rather than an afterthought.
  // The two sentences that name a credential word without assigning one are the
  // load-bearing entries: the keyed pattern requires a `:` or `=`, and dropping
  // that requirement turns "the password policy is documented" into
  // "the password=[REDACTED] is documented". The plurals matter too — a bare
  // `\bpassword\b` cannot reach inside "passwords", which is why that case has
  // never been the one doing the work.
  for (const text of [
    "harmless sentence about tokens and secrets",
    "the retry budget lives in config/runtime.yaml",
    "we should tokenize the input before comparing it",
    "passwords are hashed with argon2",
    "the secret sauce recipe",
    "the password policy is documented in the wiki"
  ]) {
    assert.equal(
      redactSensitiveText(text),
      text,
      `ordinary text was altered: ${JSON.stringify(text)}`
    );
  }
});

test("several secrets in one claim are all removed", () => {
  const redacted = redactSensitiveText(
    "password: hunter2 then Bearer abcdefgh12345 and sk-abcdefghijklmnopqrstuvwx"
  );

  for (const secret of [
    "hunter2",
    "abcdefgh12345",
    "sk-abcdefghijklmnopqrstuvwx"
  ]) {
    assert.doesNotMatch(
      redacted,
      new RegExp(secret, "u"),
      `a secret survived: ${secret}`
    );
  }
  assert.doesNotMatch(redacted, /\d=\[REDACTED\]/u);
});

test("a locator's credentials are removed without losing the reference", () => {
  const reference: EvidenceReference = {
    kind: "other",
    uri: "https://user:hunter2@example.com/repo/pull/7?access_token=abc123def456&page=2#comment"
  };

  const sanitized = sanitizeEvidenceReference(reference);

  assert.equal(
    sanitized.uri,
    "https://example.com/repo/pull/7?page=2",
    "the locator was not reduced to a credential-free form"
  );
  assert.equal(
    sanitized.kind,
    "other",
    "the reference's other fields were lost"
  );
  assert.equal(
    reference.uri.includes("hunter2"),
    true,
    "the input was mutated"
  );
});

test("a locator that is not a URL still has its secrets stripped", () => {
  // The fallback path exists because evidence is not always a URL, and a
  // credential that survives there survives because the parser gave up. The
  // locator has to be one `new URL()` actually rejects — my first attempt used
  // a `git://` URL, which parses, so it took the normal path and this test
  // proved nothing about the catch. A rooted path has no base to resolve
  // against and fails to parse, which is what sends it here.
  const sanitized = sanitizeEvidenceReference({
    kind: "other",
    uri: "/local/transcripts/2026?token=sk-abcdefghijklmnopqrstuvwx"
  });

  assert.doesNotMatch(
    sanitized.uri,
    /sk-abcdefghijklmnopqrstuvwx/u,
    "a credential survived in a locator the URL parser could not read"
  );
  assert.equal(
    sanitized.uri,
    "/local/transcripts/2026?token=[REDACTED]",
    "the locator's own content was not preserved around the redaction"
  );
});

test("a list of references is sanitized item by item", () => {
  const sanitized = sanitizeEvidence([
    { kind: "other", uri: "https://u:p@example.com/a?secret=x#frag" },
    { kind: "other", uri: "https://example.com/b" }
  ]);

  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0]?.uri, "https://example.com/a");
  assert.equal(
    sanitized[1]?.uri,
    "https://example.com/b",
    "a locator with nothing to strip was altered"
  );
});
