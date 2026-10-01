import type { EvidenceReference } from "@simulatorlife/autodev-core";

const SENSITIVE_QUERY_PARAMETER =
  /^(?:auth|authorization|access_token|refresh_token|token|secret|password|api[_-]?key|signature|sig)$/i;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*([^\s,;]+)/gi
];

/** Redacts common credential forms before any derived claim reaches persistence. */
export function redactSensitiveText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) =>
      text.replace(pattern, (match, key?: string) =>
        key ? `${key}=[REDACTED]` : "[REDACTED]"
      ),
    value
  );
}

/** Remove credentials from source locators without copying their secret query values. */
export function sanitizeEvidenceReference(
  reference: EvidenceReference
): EvidenceReference {
  let uri = reference.uri;
  try {
    const parsed = new URL(uri);
    parsed.username = "";
    parsed.password = "";
    const sensitiveKeys: string[] = [];
    parsed.searchParams.forEach((_value, key) => {
      if (SENSITIVE_QUERY_PARAMETER.test(key)) sensitiveKeys.push(key);
    });
    for (const key of sensitiveKeys) parsed.searchParams.delete(key);
    parsed.hash = "";
    uri = parsed.toString();
  } catch {
    uri = redactSensitiveText(uri);
  }
  return { ...reference, uri };
}

export function sanitizeEvidence(
  evidence: readonly EvidenceReference[]
): readonly EvidenceReference[] {
  return evidence.map(sanitizeEvidenceReference);
}
