/**
 * The browser's side of the whole-page answer.
 *
 * The Console's navigation owner waits for the destination's whole page by
 * watching the request that carries it: the browser keeps the record of the
 * request, and the owner sees that record. The record arrives through a
 * `PerformanceObserver`, and a unit test has no browser to keep one.
 *
 * So this stands in for the browser: an observer the owner can install, and an
 * answer the test can hand it. The answer is reported the way the browser
 * reports it -- as a finished request for a destination, carrying the marker
 * that says how the answer was carried.
 */

interface FakeObserver {
  readonly callback: PerformanceObserverCallback;
  observe(): void;
  disconnect(): void;
  takeRecords(): PerformanceEntry[];
}

/** The observers the owner has installed. */
const observers = new Set<FakeObserver>();

class AnswerObserver implements FakeObserver {
  readonly callback: PerformanceObserverCallback;

  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }

  observe(): void {}

  disconnect(): void {
    observers.delete(this);
  }

  takeRecords(): PerformanceEntry[] {
    return [];
  }
}

/**
 * Give the owner a browser to watch.
 *
 * Node has an observer of its own, and it keeps the record of Node's
 * requests -- not the record of the request the owner is waiting for. Without
 * this, the owner would wait for an answer that never arrives.
 */
export function installWholePageAnswerObserver(): void {
  globalThis.PerformanceObserver =
    AnswerObserver as unknown as typeof PerformanceObserver;
}

/**
 * Report that the request for a destination has finished.
 *
 * The answer carries the marker that says how it was carried, because that is
 * how the owner recognises it: the marker is not part of the destination's
 * identity.
 */
export function deliverWholePageAnswer(href: string): void {
  // The marker belongs in the query, before the hash: a destination's hash is
  // not part of its identity, and a marker behind the hash would be part of
  // the hash instead.
  const hashIndex = href.indexOf("#");
  const withoutHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex);
  const separator = withoutHash.includes("?") ? "&" : "?";
  const name = `http://console.test${withoutHash}${separator}_rsc=test${hash}`;
  const entry = {
    name,
    startTime: 0,
    responseEnd: 1
  } as PerformanceResourceTiming;
  const entries = {
    getEntries: () => [entry],
    getEntriesByName: () => [],
    getEntriesByType: () => []
  } as unknown as PerformanceObserverEntryList;
  for (const observer of observers) {
    observer.callback(entries, observer as unknown as PerformanceObserver);
  }
}

/** How many observers the owner has installed; the tests assert on this. */
export function wholePageAnswerObserverCount(): number {
  return observers.size;
}
