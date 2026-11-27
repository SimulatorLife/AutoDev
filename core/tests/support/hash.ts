import { createHash } from "node:crypto";

/**
Return the lowercase hex SHA-256 digest of a UTF-8 string or byte buffer.
*/
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
