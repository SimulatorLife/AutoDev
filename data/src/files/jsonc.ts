import { isRecord } from "@simulatorlife/autodev-core";
import {
  parse as parseJsonc,
  type ParseError,
  printParseErrorCode
} from "jsonc-parser";

/**
Parse a JSONC document into a plain JSON object using the established
`jsonc-parser` dependency, failing closed on syntax errors or non-object roots.
*/
export function parseJsoncObject(
  content: string,
  label = "JSONC document"
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(content, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });
  if (errors.length > 0) {
    const summary = errors
      .slice(0, 3)
      .map((error) => `${printParseErrorCode(error.error)}@${error.offset}`)
      .join(", ");
    throw new Error(`Invalid ${label}: ${summary}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid ${label}: root must be an object`);
  }
  return parsed;
}
