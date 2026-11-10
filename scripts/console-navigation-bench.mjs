// Benchmark for the Console's navigation latency.
//
//   node scripts/console-navigation-bench.mjs [--url http://127.0.0.1:3300] [--samples 3]
//
// The Console is a single-user control surface, and the only thing that
// matters about it is how long the operator waits. A navigation is a server
// render of the destination route: the route reads what it needs from the
// Control API and from the Usage telemetry service, and the page's answer
// arrives when those reads have answered.
//
// This measures that wait per route, so a change to a route's read set can
// be compared against what it was before. The numbers are server render
// latency; the browser's own navigation commit adds its own time on top, and
// the repository's Playwright acceptance is what measures that.
//
// The samples are reported as a minimum, a median and a maximum rather than a
// single number: the first sample of a route is a cold read (a fresh process,
// a cold ClickHouse page cache), and the rest are warm. A route whose
// minimum is small and whose maximum is enormous is a route whose reads are
// expensive but cacheable; a route whose minimum is enormous is a route that
// is slow every time.

const args = process.argv.slice(2);

function readOption(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

const BASE_URL = readOption("--url", process.env.AUTODEV_CONSOLE_URL ?? "http://127.0.0.1:3300");
const SAMPLES = Number(readOption("--samples", "3"));
const TIMEOUT_MS = Number(readOption("--timeout", "180000"));

const ROUTES = [
  "/agents",
  "/providers",
  "/providers?tab=models",
  "/providers/openai",
  "/tools",
  "/tools/antigravity",
  "/skills",
  "/mcps",
  "/hooks",
  "/prompts",
  "/permissions",
  "/memory",
  "/evaluations",
  "/github",
  "/playtesting",
  "/workspaces",
  "/usage"
];

function milliseconds(value) {
  return value.toFixed(0).padStart(7);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function sample(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(BASE_URL + path, {
      signal: controller.signal,
      headers: { accept: "text/html" }
    });
    const body = await response.text();
    const elapsed = performance.now() - started;
    return {
      ok: response.ok,
      status: response.status,
      ms: elapsed,
      bytes: Buffer.byteLength(body)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - started,
      bytes: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

console.log("Console navigation latency against " + BASE_URL);
console.log(
  "samples per route: " + SAMPLES + "   timeout: " + TIMEOUT_MS + "ms"
);
console.log("");
console.log(
  "route".padEnd(24) +
    "min ms".padStart(9) +
    "med ms".padStart(9) +
    "max ms".padStart(9) +
    "   bytes".padStart(9) +
    "  status"
);

const results = [];
for (const route of ROUTES) {
  const samples = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    samples.push(await sample(route));
  }
  const times = samples.map((entry) => entry.ms);
  const bytes = samples.at(-1)?.bytes ?? 0;
  const status = samples.at(-1)?.status ?? 0;
  results.push({
    route,
    min: Math.min(...times),
    median: median(times),
    max: Math.max(...times),
    bytes,
    status
  });
  console.log(
    route.padEnd(24) +
      milliseconds(Math.min(...times)) +
      milliseconds(median(times)) +
      milliseconds(Math.max(...times)) +
      String(bytes).padStart(9) +
      "  " + status
  );
}

const slowest = [...results].sort((left, right) => right.median - left.median);
console.log("");
console.log("slowest routes by median:");
for (const entry of slowest.slice(0, 5)) {
  console.log("  " + entry.route.padEnd(24) + entry.median.toFixed(0) + "ms");
}
