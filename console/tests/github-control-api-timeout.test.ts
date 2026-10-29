import assert from "node:assert/strict";
import test from "node:test";

import { fetchGithubWorkflows } from "../src/lib/server/control-api.ts";

const CONFIG = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "test-control-token"
};
const RESPONSE = {
  schema: "autodev-control-github-v1",
  source: ".github/workflows",
  readOnly: true,
  catalogStatus: "valid",
  totalWorkflows: 0,
  workflows: [],
  runtimeFactsAvailable: false,
  runtimeStatus: "unavailable",
  runtimeMessage:
    "GitHub Actions API request is still within its source deadline.",
  repository: null,
  stats: null,
  // The Actions read did not happen, so the runs are not observed rather than
  // empty: an empty list would say the workflows had never run.
  recentRuns: null
};

test(
  "GitHub Control API read allows a cold bounded Actions snapshot to finish",
  { timeout: 15_000 },
  async () => {
    const resultPromise = fetchGithubWorkflows(CONFIG, {
      maxRetries: 0,
      fetchImpl: (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve(Response.json(RESPONSE));
          }, 6000);
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Request aborted", "AbortError"));
          };
          signal?.addEventListener("abort", abort, { once: true });
        })
    });

    const result = await resultPromise;
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.data.runtimeFactsAvailable, false);
      assert.equal(result.data.runtimeMessage, RESPONSE.runtimeMessage);
    }
  }
);
