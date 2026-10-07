import assert from "node:assert/strict";
import test from "node:test";

import type { EvidenceReference, MemoryRecord } from "@simulatorlife/autodev-core";

import type { CurrentStateAssessment } from "../src/memory/service.ts";

import { RoutedMemoryReconstructor } from "../src/router/memory-reconstruction.ts";

/**
 * The router's reconstruction step — the model call that decides whether a
 * retrieved memory is `retain`, `revise`, `reject`, or `uncertain` — had 28%
 * coverage and no test file at all.
 *
 * Two things in here are worth more than the coverage. The constructor refuses
 * any endpoint that is not a local, credential-free HTTP URL, which is the only
 * thing between an operator's `CODEX_MODEL_ROUTER_PORT` and a request that
 * carries a memory claim to somewhere it should not go. And the response parser
 * requires *exactly* three keys: a model that returns the right answer plus an
 * extra field is refused as uncertain, because a review whose shape the Console
 * did not expect is a review it cannot safely render.
 */

const TIME = "2026-10-01T12:00:00.000Z";
const EVIDENCE: EvidenceReference = { kind: "file", uri: "file:///repo/src/feature.ts" };

const ENV_KEYS = [
  "CODEX_MODEL_ROUTER_PORT",
  "CODEX_ROUTER_AUTH_TOKEN",
  "AUTODEV_MEMORY_RECONSTRUCTION_TIMEOUT_MS"
] as const;

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => T
): T {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    // Assigned one at a time: `Object.assign(process.env, { K: undefined })`
    // writes the *string* "undefined", which is a truthy token rather than an
    // absent one.
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function memory(claim = "The retry budget lives in config/runtime.yaml."): MemoryRecord {
  return {
    id: "memory-review",
    kind: "semantic",
    scope: {
      kind: "repository",
      workspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev"
    },
    claim,
    status: "active",
    provenance: {
      experienceIds: ["experience-a"],
      evidence: [EVIDENCE],
      createdBy: "root",
      createdAt: TIME,
      lastVerifiedAt: TIME,
      verificationSource: "git-current-state"
    },
    validity: { state: "verified", checkedAt: TIME, evidence: [EVIDENCE] },
    createdAt: TIME,
    updatedAt: TIME
  };
}

function assessment(
  overrides: Partial<CurrentStateAssessment> = {}
): CurrentStateAssessment {
  return {
    compatibility: "compatible",
    source: "git-current-state",
    checkedAt: TIME,
    evidence: [EVIDENCE],
    reasonCode: "verified_current_state",
    ...overrides
  } as CurrentStateAssessment;
}

/** A reconstructor whose endpoint is the default, with a recording fetch. */
function rig(
  options: {
    readonly body?: unknown;
    readonly text?: string;
    readonly status?: number;
    readonly throwOnFetch?: boolean;
    readonly authToken?: string;
  } = {}
): {
  readonly reconstructor: RoutedMemoryReconstructor;
  readonly requests: Array<{ readonly url: string; readonly init: RequestInit }>;
} {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const reconstructor = new RoutedMemoryReconstructor({
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (options.throwOnFetch === true) throw new Error("router unreachable");
      const payload = options.text ?? JSON.stringify(options.body ?? {});
      return new Response(payload, {
        status: options.status ?? 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch,
    ...(options.authToken === undefined ? {} : { authToken: options.authToken })
  });
  return { reconstructor, requests };
}

const VALID_REVIEW = {
  disposition: "retain",
  guidance: "Raise the retry budget to three attempts.",
  rationale: "The cited file still sets the budget to two."
};

function reviewResponse(review: unknown): unknown {
  return { output_text: JSON.stringify(review) };
}

async function review(
  reconstructor: RoutedMemoryReconstructor,
  overrides: {
    readonly claim?: string;
    readonly task?: string;
    readonly assessment?: CurrentStateAssessment;
  } = {}
): Promise<{ readonly disposition: string; readonly guidance?: string; readonly rationale: string }> {
  return reconstructor.reconstruct({
    memory: memory(overrides.claim ?? memory().claim),
    task: overrides.task ?? "Raise the retry budget.",
    assessment: overrides.assessment ?? assessment()
  });
}

test("the endpoint defaults to the local router and is built once", () => {
  withEnv({}, () => {
    const { reconstructor, requests } = rig({ body: reviewResponse(VALID_REVIEW) });
    void reconstructor;
    assert.equal(requests.length, 0, "constructing must not make a request");
  });
  withEnv({ CODEX_MODEL_ROUTER_PORT: "5999" }, () => {
    const { reconstructor, requests } = rig({ body: reviewResponse(VALID_REVIEW) });
    void review(reconstructor);
    assert.equal(requests[0]?.url, "http://127.0.0.1:5999/v1/responses");
  });
  // Anything that is not a plausible port falls back rather than throwing: the
  // router being on the default is better than memory reconstruction being off.
  //
  // `1e3` and `0x1004` are the discriminating cases. `Number` reads them as real
  // ports, so a module that dropped the digit-pattern check would silently honour
  // them -- the range check alone does not catch them. `+4100` is not one: it
  // parses to 4100, which is the default anyway, so it cannot tell the two
  // guards apart.
  for (const port of ["", "abc", "-1", "70000", "4100.5", "1e3", "0x1004"]) {
    withEnv({ CODEX_MODEL_ROUTER_PORT: port }, () => {
      const { reconstructor, requests } = rig({ body: reviewResponse(VALID_REVIEW) });
      void review(reconstructor);
      assert.equal(
        requests[0]?.url,
        "http://127.0.0.1:4100/v1/responses",
        `port ${JSON.stringify(port)} must fall back to the default`
      );
    });
  }
});

test("an endpoint that is not local, plain HTTP, and credential-free is refused", () => {
  // The memory claim and its evidence leave the process in this request, so
  // this constructor is a boundary and not configuration parsing.
  for (const endpoint of [
    "https://127.0.0.1:4100/v1/responses",
    "http://example.com/v1/responses",
    // The cloud instance-metadata address, reachable from most CI runners.
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/v1/responses",
    "http://user:pass@127.0.0.1:4100/v1/responses",
    "http://token@127.0.0.1:4100/v1/responses",
    "ftp://127.0.0.1:4100/v1/responses"
  ]) {
    assert.throws(
      () => new RoutedMemoryReconstructor({ endpoint }),
      /must be an HTTP URL without credentials/u,
      `${endpoint} must be refused by the endpoint policy`
    );
  }
  // An unparseable endpoint fails differently -- `new URL` throws before the
  // policy is reached -- so it is asserted as a refusal without a message.
  assert.throws(
    () => new RoutedMemoryReconstructor({ endpoint: "not a url at all" }),
    "an unparseable endpoint must be refused"
  );
  // The three local spellings are the ones that must keep working.
  for (const endpoint of [
    "http://127.0.0.1:4100/v1/responses",
    "http://localhost:4100/v1/responses",
    "http://[::1]:4100/v1/responses"
  ]) {
    assert.doesNotThrow(() => new RoutedMemoryReconstructor({ endpoint }));
  }
});

test("a well-formed review is returned with its guidance trimmed", async () => {
  const { reconstructor, requests } = rig({
    body: reviewResponse({ ...VALID_REVIEW, guidance: `  ${VALID_REVIEW.guidance}  ` })
  });

  const result = await review(reconstructor);

  assert.equal(result.disposition, "retain");
  assert.equal(result.guidance, VALID_REVIEW.guidance, "guidance must be trimmed");
  assert.equal(result.rationale, VALID_REVIEW.rationale);

  const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body.stream, false);
  assert.equal(body.max_output_tokens, 512);
  assert.deepEqual(body.tools, []);
  // `developer` is the load-bearing part: the root router's memory trigger only
  // re-researches a *new user-authored* steer, so a developer message is what
  // stops this call from recursing into another one.
  assert.deepEqual(
    (body.input as Array<{ role: string }>)[0]?.role,
    "developer",
    "the review must not arrive as a user message"
  );
});

test("the review request carries no more than the bounded context", async () => {
  const { reconstructor, requests } = rig({ body: reviewResponse(VALID_REVIEW) });

  // Twenty references, so the cap at twelve is doing something. A fixture with
  // one reference passes the cap check whether or not it exists.
  await review(reconstructor, {
    assessment: assessment({
      evidence: Array.from({ length: 20 }, (_, index) => ({
        kind: "file" as const,
        uri: `file:///repo/file-${index}.ts`
      }))
    })
  });

  const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
  const message = (body.input as Array<{ content: Array<{ text: string }> }>)[0];
  const context = JSON.parse(message?.content[0]?.text ?? "{}") as Record<string, unknown>;
  const currentState = context.currentState as {
    readonly evidence: ReadonlyArray<Record<string, unknown>>;
  };
  assert.equal(
    currentState.evidence.length,
    12,
    "evidence must be capped at twelve references"
  );
});

test("a memory whose current state cannot support a review is never sent", async () => {
  // Failing closed here means no request at all -- the claim and its evidence
  // do not leave the process for a review that could not have changed the
  // answer.
  const cases: ReadonlyArray<readonly [string, Parameters<typeof review>[1]]> = [
    ["a contradicted assessment", { assessment: assessment({ compatibility: "contradicted" }) }],
    ["an assessment with no evidence", { assessment: assessment({ evidence: [] }) }],
    ["an empty claim", { claim: "   " }],
    ["an empty task", { task: "   " }],
    ["a claim past the bound", { claim: "c".repeat(4001) }]
  ];

  for (const [label, overrides] of cases) {
    const { reconstructor, requests } = rig({ body: reviewResponse(VALID_REVIEW) });
    const result = await review(reconstructor, overrides);

    assert.equal(requests.length, 0, `${label} must not be sent to the router`);
    assert.equal(result.disposition, "uncertain", `${label} must fall back to uncertain`);
  }
});

test("an over-long context is refused rather than sent", async () => {
  const long = "u".repeat(600);
  const { reconstructor, requests } = rig({ body: reviewResponse(VALID_REVIEW) });

  const result = await review(reconstructor, {
    claim: "c".repeat(4000),
    assessment: assessment({
      evidence: Array.from({ length: 12 }, () => ({
        kind: "file" as const,
        uri: `file:///repo/${long}`,
        revision: "r".repeat(128)
      }))
    })
  });

  assert.equal(requests.length, 0, "an over-long context must not be sent");
  assert.equal(result.disposition, "uncertain");
});

test("an over-long task is truncated for the review, not refused", async () => {
  // There was a `normalizedTask.length > MAX_TASK_CHARACTERS` check here, and
  // it could never fire: `memoryQueryFromTask` bounds its result by the same
  // limit. The two were 4000 by coincidence rather than by construction, which
  // is why the check read as a rule that merely happened to be unreachable. It
  // is one constant now, and the check is gone.
  //
  // Asserted as the behaviour that exists, because the alternative -- a test
  // asserting a refusal -- would pass for a reason the code never produces.
  // The bound below is written out rather than imported from the shared
  // constant, so that raising it has to be a deliberate edit here too.
  const { reconstructor, requests } = rig({ body: reviewResponse(VALID_REVIEW) });

  const result = await review(reconstructor, { task: "t".repeat(9000) });

  assert.equal(requests.length, 1, "a bounded task must still be reviewed");
  assert.equal(result.disposition, "retain");

  const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
  const message = (body.input as Array<{ content: Array<{ text: string }> }>)[0];
  const context = JSON.parse(message?.content[0]?.text ?? "{}") as {
    readonly task: string;
  };
  assert.ok(
    context.task.length <= 4000,
    `the task reached the router at ${context.task.length} characters`
  );
  assert.ok(context.task.startsWith("t".repeat(50)), "the opening constraint must survive");
  assert.ok(context.task.endsWith("t".repeat(50)), "the final constraint must survive");
});

test("the router's authorization header appears only when a token is configured", () => {
  // `CODEX_ROUTER_AUTH_TOKEN` is read from the process environment, and this
  // machine has one set -- without the isolation below the "no token" case would
  // silently borrow the developer's own router credential.
  withEnv({ CODEX_ROUTER_AUTH_TOKEN: undefined }, () => {
    const without = rig({ body: reviewResponse(VALID_REVIEW) });
    void review(without.reconstructor);
    const plain = without.requests[0]?.init.headers as Record<string, string>;
    assert.equal(plain.authorization, undefined, "no token means no bearer header");
  });
  withEnv({ CODEX_ROUTER_AUTH_TOKEN: undefined }, () => {
    const withToken = rig({
      body: reviewResponse(VALID_REVIEW),
      authToken: `  router-token  `
    });
    void review(withToken.reconstructor);
    const authenticated = withToken.requests[0]?.init.headers as Record<string, string>;
    assert.equal(
      authenticated.authorization,
      "Bearer router-token",
      "the token must be trimmed"
    );
  });
});

test("a review carrying a key the Console does not expect is uncertain", async () => {
  // Strictly three keys. A model that answers correctly *and* adds a field is
  // refused rather than partially read, because a shape this parser did not
  // anticipate is one the caller also did not anticipate.
  const withExtra = await review(
    rig({ body: reviewResponse({ ...VALID_REVIEW, confidence: 0.9 }) }).reconstructor
  );
  assert.equal(withExtra.disposition, "uncertain", "an extra key must be refused");

  const missing = await review(
    rig({ body: reviewResponse({ disposition: "retain", guidance: "x" }) }).reconstructor
  );
  assert.equal(missing.disposition, "uncertain", "a missing key must be refused");
});

test("a disposition that keeps or rewrites a memory must come with guidance", async () => {
  // Without guidance a `retain` renders as an empty instruction to the model --
  // the memory is cited but says nothing, which is worse than not citing it.
  for (const disposition of ["retain", "revise"] as const) {
    const withoutGuidance = await review(
      rig({
        body: reviewResponse({ disposition, rationale: "looks fine" })
      }).reconstructor
    );
    assert.equal(
      withoutGuidance.disposition,
      "uncertain",
      `${disposition} without guidance must be uncertain`
    );
    assert.equal(withoutGuidance.guidance, undefined);

    const blankGuidance = await review(
      rig({
        body: reviewResponse({ disposition, guidance: "   ", rationale: "looks fine" })
      }).reconstructor
    );
    assert.equal(blankGuidance.disposition, "uncertain", `blank guidance for ${disposition}`);
  }

  // A rejection has nothing to guide, so it needs none.
  const rejected = await review(
    rig({
      body: reviewResponse({ disposition: "reject", guidance: null, rationale: "stale" })
    }).reconstructor
  );
  assert.equal(rejected.disposition, "reject");
  assert.equal(rejected.guidance, undefined);
});

test("everything else that is not a usable review is uncertain", async () => {
  const unusable: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["a disposition outside the vocabulary", { disposition: "keep", guidance: "g", rationale: "r" }],
    ["an empty rationale", { disposition: "retain", guidance: "g", rationale: "   " }],
    ["a rationale past the bound", { disposition: "retain", guidance: "g", rationale: "r".repeat(2001) }],
    ["a non-string rationale", { disposition: "retain", guidance: "g", rationale: 42 }],
    [
      // `reject`, not `retain`: a retain with unusable guidance is caught by the
      // "a kept memory must come with guidance" rule, which would mask the type
      // check this is aimed at.
      "a guidance that is neither a string nor null",
      { disposition: "reject", guidance: { text: "g" }, rationale: "r" }
    ],
    [
      "a guidance past the bound",
      { disposition: "retain", guidance: "g".repeat(4001), rationale: "r" }
    ]
  ];

  for (const [label, reviewBody] of unusable) {
    const { reconstructor } = rig({ body: reviewResponse(reviewBody) });
    const result = await review(reconstructor);

    assert.equal(result.disposition, "uncertain", `${label} must be uncertain`);
    assert.equal(
      result.rationale,
      "The existing provider route did not return a valid reconstruction.",
      `${label} must carry the fixed fallback rationale`
    );
  }
});

test("an unsure model answer is distinguishable from the failure fallback", async () => {
  // `uncertain` is in the disposition vocabulary, so a router may answer it
  // deliberately. That answer must not be mistaken for the fallback, which
  // carries a fixed rationale of its own.
  const { reconstructor } = rig({
    body: reviewResponse({
      disposition: "uncertain",
      guidance: null,
      rationale: "The evidence does not settle whether the claim still holds."
    })
  });

  const result = await review(reconstructor);

  assert.equal(result.disposition, "uncertain");
  assert.equal(
    result.rationale,
    "The evidence does not settle whether the claim still holds.",
    "a deliberate uncertainty must keep its own rationale"
  );
  assert.notEqual(
    result.rationale,
    "The existing provider route did not return a valid reconstruction."
  );
});

test("a router that cannot answer is uncertain, and the task is unaffected", async () => {
  // Every failure path has to land on `uncertain` rather than throw: this runs
  // inside a request that must not fail because memory could not be reviewed.
  const failed = await review(rig({ throwOnFetch: true }).reconstructor);
  assert.equal(failed.disposition, "uncertain");

  for (const status of [400, 401, 500, 503]) {
    const errored = await review(
      rig({ body: reviewResponse(VALID_REVIEW), status }).reconstructor
    );
    assert.equal(errored.disposition, "uncertain", `HTTP ${status} must be uncertain`);
  }

  for (const payload of ["", "not json", "[]", "null", '{"output_text":"not json"}', "{}"]) {
    const unusable = await review(rig({ text: payload }).reconstructor);
    assert.equal(
      unusable.disposition,
      "uncertain",
      `${JSON.stringify(payload)} must be uncertain`
    );
  }
});

test("the review text is read from either response shape", async () => {
  const viaOutputText = await review(rig({ body: reviewResponse(VALID_REVIEW) }).reconstructor);
  assert.equal(viaOutputText.disposition, "retain");

  const viaOutput = await review(
    rig({
      body: {
        output: [
          { content: [{ type: "output_text", text: JSON.stringify(VALID_REVIEW) }] }
        ]
      }
    }).reconstructor
  );
  assert.equal(viaOutput.disposition, "retain", "the content-array shape must be read");

  // A different content type carries no review text and must not be scraped.
  const wrongType = await review(
    rig({
      body: { output: [{ content: [{ type: "refusal", text: JSON.stringify(VALID_REVIEW) }] }] }
    }).reconstructor
  );
  assert.equal(wrongType.disposition, "uncertain");
});

test("a response larger than the cap is refused without being parsed", async () => {
  // A *valid* review inside an over-cap body. A body whose only content is a
  // huge string is refused by the 12k character bound downstream instead, so the
  // byte cap would look tested while never running.
  const { reconstructor } = rig({
    text: JSON.stringify({
      output_text: JSON.stringify(VALID_REVIEW),
      padding: "x".repeat(70 * 1024)
    })
  });

  const result = await review(reconstructor);

  assert.equal(
    result.disposition,
    "uncertain",
    "an over-cap response must be refused rather than read"
  );
});