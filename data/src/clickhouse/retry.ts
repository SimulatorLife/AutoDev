/**
 * Connection-level retry shared by every ClickHouse read and write path.
 *
 * The OpenLIT stack talks to ClickHouse over plain HTTP, so a dropped socket
 * is an ordinary transport failure rather than a data error. Both the
 * statement client and the evaluation repository need the same behaviour:
 * retry a connection reset, refusal, or timeout, and surface anything else to
 * the caller unchanged. Keeping the policy in one place stops the two paths
 * from drifting apart on which failures are retryable.
 */

/** Syscall codes that mean the connection itself failed, not the statement. */
const RETRYABLE_SYSCALL_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT"
]);

export interface ClickHouseRetryOptions {
  /** Additional attempts made after the first one fails. Defaults to 2. */
  readonly maxRetries?: number;
  /** Base delay in milliseconds; the wait grows linearly with the attempt. */
  readonly baseDelayMs?: number;
}

/**
 * True when a failure is a connection-level transport error worth retrying.
 *
 * The code is read from the error's `cause`, which is where Node surfaces the
 * underlying syscall failure for `fetch` rejections.
 */
export function isRetryableClickHouseTransportError(error: unknown): boolean {
  const cause = (error as { readonly cause?: unknown } | null | undefined)
    ?.cause;
  const code = (cause as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && RETRYABLE_SYSCALL_CODES.has(code);
}

/** Resolve after `milliseconds`, without leaking the timer handle. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Run `operation` and retry it while it fails with a retryable transport
 * error, up to `maxRetries` additional attempts.
 *
 * Attempts are sequential by design: a retry must observe the previous
 * attempt's outcome before the next request starts, so a reset socket is never
 * raced by a second in-flight statement.
 */
export async function withClickHouseConnectionRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: ClickHouseRetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 100;
  /* eslint-disable no-await-in-loop -- each attempt must settle before the next request starts */
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        attempt >= maxRetries ||
        !isRetryableClickHouseTransportError(error)
      ) {
        throw error;
      }
      await delay(baseDelayMs * (attempt + 1));
    }
  }
  /* eslint-enable no-await-in-loop */
  throw new Error("ClickHouse request retries exhausted");
}
