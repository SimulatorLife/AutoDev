#!/usr/bin/env node
/** Descriptive comparison of investigation metrics in session-trace --json files. */
import { readFileSync } from "node:fs";

const metricNames = [
  "toolCalls",
  "tokens",
  "filesRead",
  "repeatedReads",
  "searches",
  "repeatedSearches",
  "ccc",
  "cgc",
  "lsp"
] as const;
type Metric = (typeof metricNames)[number];
type CodeContext = "ccc" | "cgc" | "lsp";
interface Investigation {
  observed: boolean;
  toolCalls?: number;
  tokens?: number | null;
  filesRead?: number;
  repeatedReads?: number;
  searches?: number;
  repeatedSearches?: number;
  context?: Partial<Record<CodeContext, number>>;
}
interface Trace {
  investigation: Investigation;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validateThreads(value: unknown, label: string): Trace[] {
  if (!Array.isArray(value))
    throw new Error(
      `${label}: expected a session-trace JSON object with a threads array`
    );
  return value.map((thread, index) => {
    const where = `${label}: threads[${index}]`;
    if (!isObject(thread)) throw new Error(`${where} must be an object`);
    if (!isObject(thread.investigation))
      throw new Error(`${where}.investigation must be an object`);
    const raw = thread.investigation;
    if (typeof raw.observed !== "boolean")
      throw new Error(`${where}.investigation.observed must be a boolean`);
    for (const key of [
      "toolCalls",
      "filesRead",
      "repeatedReads",
      "searches",
      "repeatedSearches"
    ] as const) {
      const val = raw[key];
      if (
        val !== undefined &&
        (typeof val !== "number" || !Number.isFinite(val))
      )
        throw new Error(
          `${where}.investigation.${key} must be a finite number when present`
        );
    }
    if (
      raw.tokens !== undefined &&
      raw.tokens !== null &&
      (typeof raw.tokens !== "number" || !Number.isFinite(raw.tokens))
    )
      throw new Error(
        `${where}.investigation.tokens must be a finite number or null when present`
      );
    if (raw.context !== undefined) {
      if (!isObject(raw.context))
        throw new Error(
          `${where}.investigation.context must be an object when present`
        );
      for (const key of ["ccc", "cgc", "lsp"] as const) {
        const val = raw.context[key];
        if (
          val !== undefined &&
          (typeof val !== "number" || !Number.isFinite(val))
        )
          throw new Error(
            `${where}.investigation.context.${key} must be a finite number when present`
          );
      }
    }
    return { investigation: raw as unknown as Investigation };
  });
}
function load(file: string): Trace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${file}: could not read valid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!isObject(parsed))
    throw new Error(
      `${file}: expected a session-trace JSON object with a threads array`
    );
  return validateThreads(parsed.threads, file);
}
function metricValue(
  record: Investigation,
  metric: Metric
): number | undefined {
  if (metric === "ccc" || metric === "cgc" || metric === "lsp")
    return record.context?.[metric];
  return record[metric];
}
function aggregate(threads: Trace[]) {
  const available = threads.filter((thread) => thread.investigation.observed);
  const unavailableThreads = threads.length - available.length;
  return {
    threads: threads.length,
    observedThreads: available.length,
    unavailableThreads,
    metrics: Object.fromEntries(
      metricNames.map((metric) => {
        const values = available
          .map((thread) => metricValue(thread.investigation, metric))
          .filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value)
          );
        const total =
          values.length > 0
            ? values.reduce((sum, value) => sum + value, 0)
            : null;
        return [
          metric,
          {
            observed: values.length,
            missing: threads.length - values.length,
            unavailableThreads,
            total,
            mean: total === null ? null : total / values.length
          }
        ];
      })
    )
  };
}
export function compareInvestigations(before: Trace[], after: Trace[]) {
  const beforeSummary = aggregate(validateThreads(before, "before"));
  const afterSummary = aggregate(validateThreads(after, "after"));
  return {
    note: "Descriptive comparison only; differences do not establish causation.",
    before: beforeSummary,
    after: afterSummary,
    deltas: Object.fromEntries(
      metricNames.map((metric) => {
        const oldValue = beforeSummary.metrics[metric],
          newValue = afterSummary.metrics[metric];
        return [
          metric,
          {
            total:
              oldValue.total === null || newValue.total === null
                ? null
                : newValue.total - oldValue.total,
            mean:
              oldValue.mean === null || newValue.mean === null
                ? null
                : newValue.mean - oldValue.mean
          }
        ];
      })
    )
  };
}
if (process.argv[1]?.endsWith("investigation-compare.ts")) {
  const [beforeFile, afterFile, ...extra] = process.argv.slice(2);
  if (!beforeFile || !afterFile || extra.length > 0) {
    process.stderr.write(
      "usage: investigation-compare.ts <before-trace.json> <after-trace.json>\n"
    );
    process.exitCode = 2;
  } else
    try {
      process.stdout.write(
        `${JSON.stringify(
          compareInvestigations(load(beforeFile), load(afterFile)),
          null,
          2
        )}\n`
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
}
