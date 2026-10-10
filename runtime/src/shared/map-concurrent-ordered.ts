/**
 * Map a list in bounded, ordered batches.
 *
 * Each batch runs concurrently; results are returned in input order and the
 * next batch does not start until every task in the current batch settles. If a
 * task fails, peers in its batch are allowed to settle before the earliest
 * in-order failure is rethrown, so callers never leave detached I/O behind.
 */
export async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer.");
  }

  const results: R[] = [];
  /* eslint-disable no-await-in-loop -- a batch must settle before the next batch starts */
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(
      batch.map((item, index) =>
        Promise.resolve().then(() => map(item, offset + index))
      )
    );

    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  /* eslint-enable no-await-in-loop */
  return results;
}
