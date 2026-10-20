import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_API_PLAYTESTING_READINESS_SCHEMA } from "@simulatorlife/autodev-core";

import { fetchPlaytestingReadiness } from "../app/playtesting/playtesting-server.ts";

const CONFIG = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "test-control-token"
};
const WORKSPACE_ID = "SimulatorLife/RacingGame";
const READINESS = {
  schema: CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
  workspaceId: WORKSPACE_ID,
  status: "ready"
};

test(
  "playtesting Control API read allows a slow snapshot to finish",
  { timeout: 20_000 },
  async () => {
    const resultPromise = fetchPlaytestingReadiness(WORKSPACE_ID, CONFIG, {
      maxRetries: 0,
      fetchImpl: (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve(Response.json(READINESS));
          }, 6000);
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Request aborted", "AbortError"));
          };
          signal?.addEventListener("abort", abort, { once: true });
        })
    });

    const result = await resultPromise;
    assert.equal(
      result.kind,
      "ok",
      "a playtesting read that answers after the generic Control API deadline must not be reported as a Control API failure: " +
        JSON.stringify(result)
    );
    if (result.kind === "ok") {
      assert.equal(result.data.status, "ready");
    }
  }
);
