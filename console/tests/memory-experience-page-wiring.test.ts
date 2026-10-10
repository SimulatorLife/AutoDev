import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import MemoryPage from "../app/memory/page.ts";

/**
 * The selected-experience page, rendered from wire data for the first time.
 *
 * Opening an experience makes the page issue four reads against one id: the
 * detail, the observed injection outcomes, the curator's use assessments, and
 * the reporter's session outcome. Every page test that selected an experience
 * answered all four with either a 404 or the experiences *list* schema, so all
 * four were rejected on `schema` and the panel rendered its "could not be read"
 * state — meaning the memory surface an operator actually looks at had never
 * been rendered with data, and every test of it passed props straight to a
 * component instead. A disagreement between what the Runtime sends and what the
 * panel reads was therefore invisible: each half was tested, the wiring was not.
 *
 * Two things are pinned here. The first is the composition — all four reads
 * land and the operator sees each one. The second is the detail guard whose
 * comment records that its absence caused a live 500, and which no test
 * reached: `isMemoryExperienceRow` requires `trajectory`, because the detail
 * panel dereferences `experience.trajectory.format`.
 */

const WORKSPACE = "SimulatorLife/AutoDev";
const EXPERIENCE_ID = "exp-1";

const ENV_KEYS = [
  "HOME",
  "CODEX_HOME",
  "AUTODEV_OPENLIT_SECRET_FILE",
  "AUTODEV_CONTROL_API_TOKEN",
  "AUTODEV_CONTROL_API_BASE_URL"
] as const;

/**
 * An experience row carrying every member the detail panel reads, including the
 * trajectory's normalizer, digest and diagnostic codes — the members whose
 * blocks nothing had ever executed.
 */
function experience(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: EXPERIENCE_ID,
    workspaceId: WORKSPACE,
    scope: {
      kind: "repository",
      workspaceId: WORKSPACE,
      repositoryId: WORKSPACE
    },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    agentRole: "implementer",
    evidence: [],
    trajectory: {
      format: "codex",
      uri: "codex://session/exp-1",
      sourceAdapter: "codex-native",
      normalizerId: "codex.rollout.v1",
      normalizerVersion: "3",
      digest: "sha256:0123456789abcdef0123456789abcdef",
      diagnosticCodes: ["trajectory.truncated"]
    },
    ...overrides
  };
}

/** An observed injection: the outcome join carries the token, use does not. */
function injection(withToken: boolean): Record<string, unknown> {
  return {
    id: "inj-1",
    memoryMode: "active",
    injectionResult: "applied",
    packetCharacterCount: 2048,
    memoryIds: ["mem-1"],
    occurredAt: "2026-10-07T08:59:00.000Z",
    ...(withToken ? { correlationToken: "tok-1" } : {})
  };
}

function evidencePage(
  schema: string,
  items: readonly unknown[]
): Record<string, unknown> {
  return {
    schema,
    experienceId: EXPERIENCE_ID,
    items,
    total: items.length,
    limit: 50,
    offset: 0
  };
}

const OUTCOME_ROW = {
  injection: injection(true),
  outcome: {
    outcomeKind: "failure",
    reportKind: "injection",
    reportedAt: "2026-10-07T09:00:00.000Z",
    reporterId: "operator@example",
    reporterAuthority: "operator",
    reasonCode: "reported"
  },
  sessionInjectionCount: 3
};

const OUTCOMES_PAGE = evidencePage("autodev-memory-injection-outcomes-v1", [
  OUTCOME_ROW
]);

const USE_ASSESSMENTS_PAGE = evidencePage(
  "autodev-memory-injection-use-assessments-v1",
  [
    {
      injection: injection(false),
      use: {
        useKind: "used",
        usedMemoryIds: ["mem-1"],
        reportedAt: "2026-10-07T09:01:00.000Z",
        evidence: []
      },
      sessionInjectionCount: 3
    }
  ]
);

const SESSION_OUTCOME = {
  schema: "autodev-memory-session-outcome-report-v1",
  experienceId: EXPERIENCE_ID,
  report: {
    outcomeKind: "failure",
    reportKind: "task",
    reporterId: "operator@example",
    reportedAt: "2026-10-07T09:02:00.000Z",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "trajectory", uri: "codex://session/exp-1" }]
  }
};

interface Wire {
  /** Replaces one response body, so a test can hand back a drifted shape. */
  readonly override?: ((path: string, body: unknown) => unknown) | undefined;
  /** Fails one read outright, so the page's failure mapping can be observed. */
  readonly fail?: ((path: string) => boolean) | undefined;
}

function route(path: string, wire: Wire): unknown {
  if (wire.override) {
    const replaced = wire.override(path, route(path, { fail: wire.fail }));
    if (replaced !== undefined) return replaced;
  }
  if (path.startsWith("/control/workspaces")) {
    return {
      schema: "autodev-control-workspaces-v1",
      source: "config/workspaces.json",
      readOnly: true,
      catalogStatus: "valid",
      totalWorkspaces: 1,
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ]
    };
  }
  if (path.startsWith("/control/memory/status")) {
    return {
      schema: "autodev-memory-status-v1",
      storage: {
        backend: "postgresql",
        probeTimeoutMs: 2500,
        state: "reachable",
        embeddings: "configured"
      }
    };
  }
  if (path.startsWith("/control/memory/session-cohorts")) {
    return {
      schema: "autodev-memory-session-outcome-cohorts-v1",
      cells: [],
      sessionCount: 0,
      reportedSessionCount: 0,
      unreportedSessionCount: 0
    };
  }
  if (path.startsWith("/control/memory/records")) {
    return {
      schema: "autodev-memory-records-v1",
      items: [],
      total: 0,
      limit: 50,
      statusCounts: {
        proposed: 0,
        active: 0,
        superseded: 0,
        invalidated: 0,
        uncertain: 0
      },
      offset: 0,
      hasMore: false
    };
  }
  // Sub-resources are matched before the bare detail, which is the order the
  // Runtime nests them in.
  if (/\/experiences\/[^/?]+\/session-outcomes\b/u.test(path))
    return SESSION_OUTCOME;
  if (/\/experiences\/[^/?]+\/use-assessments\b/u.test(path))
    return USE_ASSESSMENTS_PAGE;
  if (/\/experiences\/[^/?]+\/outcomes\b/u.test(path)) return OUTCOMES_PAGE;
  if (/\/experiences\/[^/?]+\?/u.test(path)) {
    return { schema: "autodev-memory-experience-v1", experience: experience() };
  }
  if (path.startsWith("/control/memory/experiences")) {
    return {
      schema: "autodev-memory-experiences-v1",
      items: [experience()],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false
    };
  }
  throw new Error(`Unexpected Memory page request: ${path}`);
}

async function renderExperiencePage(
  wire: Wire = {}
): Promise<{ readonly markup: string; readonly paths: readonly string[] }> {
  const previousFetch = globalThis.fetch;
  const saved = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );
  // `HOME` is redirected because the Control API credential otherwise falls back
  // to a real `~/.codex/openlit-secrets.env`, which would make this file's
  // hermetic-ness a property of the machine it runs on.
  const isolatedHome = mkdtempSync(
    join(tmpdir(), "autodev-memory-experience-")
  );
  const paths: string[] = [];
  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN = "memory-experience-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4102";
    globalThis.fetch = (async (input: unknown) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/u, "");
      paths.push(path);
      if (wire.fail?.(path) === true) {
        return Response.json(
          { error: { code: "autodev_control_unavailable", message: "forced" } },
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
      return Response.json(route(path, wire) as never, {
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const markup = renderToStaticMarkup(
      await MemoryPage({
        searchParams: Promise.resolve({
          tab: "experiences",
          experienceId: EXPERIENCE_ID
        })
      })
    );
    return { markup, paths };
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

test("an opened experience renders all four of its reads, not the unread state", async () => {
  const { markup, paths } = await renderExperiencePage();

  // All four reads were actually issued. Without this the assertions below
  // could be satisfied by a page that never asked.
  for (const suffix of [
    `/experiences/${EXPERIENCE_ID}?`,
    `/experiences/${EXPERIENCE_ID}/outcomes?`,
    `/experiences/${EXPERIENCE_ID}/use-assessments?`,
    `/experiences/${EXPERIENCE_ID}/session-outcomes?`
  ]) {
    assert.ok(
      paths.some((path) => path.includes(suffix)),
      `the page never read ${suffix}`
    );
  }

  // The detail, with the members only a real experience carries.
  assert.match(markup, /Task: task-1 \| Run: run-1/u);
  assert.match(markup, /codex:\/\/session\/exp-1/u);
  assert.match(markup, /codex\.rollout\.v1/u);
  assert.match(markup, /trajectory\.truncated/u);

  // The observed outcome and the curator's assessment, which are separate reads.
  // Both panels print the injection's own fields, so an anchor on those cannot
  // say which read produced the row. The two markers below are the ones only
  // each panel reaches *with items in it* — the empty states carry the same
  // `data-evidence` marker — so each needs its content assertion as well.
  assert.match(markup, /data-evidence="outcomes"/u);
  assert.match(markup, /Reported outcome/u);
  assert.match(markup, /data-evidence="use-assessments"/u);
  assert.match(markup, /used \(1\/1 memories cited\)/u);

  // The reporter's session outcome, by the panel's own marker.
  assert.match(
    markup,
    new RegExp(`data-session-outcome="${EXPERIENCE_ID}"`, "u")
  );
  assert.match(markup, /operator@example/u);
});

test("a drifted detail is refused rather than rendered as an experience", async () => {
  // The guard whose absence produced a live 500: the detail panel dereferences
  // `experience.trajectory.format`, so an envelope whose `experience` has no
  // trajectory must fail the read rather than reach the view.
  //
  // The row is otherwise complete on purpose. `isMemoryExperienceRow` checks ten
  // members, so a stub that dropped several of them would still be refused with
  // the trajectory check intact, and the guard under test would go untested.
  const { markup } = await renderExperiencePage({
    override: (path) => {
      if (!/\/experiences\/[^/?]+\?/u.test(path)) return undefined;
      const { trajectory: _trajectory, ...withoutTrajectory } = experience();
      return {
        schema: "autodev-memory-experience-v1",
        experience: withoutTrajectory
      };
    }
  });

  assert.doesNotMatch(
    markup,
    /Task: \| Run:/u,
    "a detail with no task or run must not render as if it had one"
  );
  assert.match(
    markup,
    /Selected memory experience could not be loaded/u,
    "the failed detail must be reported, not rendered as an empty experience"
  );
});

test("an evidence page for another experience is not drawn as evidence for this one", async () => {
  // Both evidence pages share `isExperienceEvidencePage`, which compares
  // `experienceId` rather than type-checking it. A page answered with another
  // experience's rows would otherwise be shown as this one's evidence.
  //
  // The dangerous shape is the empty claim: a refused read becomes `null`, and
  // `null` renders "No curator has assessed whether any injected packet was
  // used." An unreadable answer must not turn into an assertion that nobody
  // ever looked.
  const { markup } = await renderExperiencePage({
    override: (path) => {
      if (!/\/experiences\/[^/?]+\/use-assessments\b/u.test(path))
        return undefined;
      return { ...USE_ASSESSMENTS_PAGE, experienceId: "exp-2" };
    }
  });

  assert.doesNotMatch(
    markup,
    /used \(1\/1 memories cited\)/u,
    "another experience's use assessment must not be shown for this one"
  );
  assert.doesNotMatch(
    markup,
    /No curator has assessed/u,
    "a refused read must not be rendered as 'nobody assessed anything'"
  );
  assert.match(
    markup,
    /data-status="unavailable" data-evidence="use-assessments"/u,
    "the refused panel must say it was not observed"
  );
});

test("one unaddressable row refuses the whole outcomes page, not just its row", async () => {
  // The outcome join requires the correlation token even though the panel never
  // renders it, because the panel renders a *form* that submits it as a hidden
  // field. A row without one would offer an operator a report that cannot be
  // addressed.
  //
  // It refuses the entire page, because `isExperienceEvidencePage` validates
  // with `items.every(...)` rather than per row. That is the fail-closed
  // choice, and it is worth stating: dropping only the bad row would render a
  // shorter list, which reads as "these were the only injections this session
  // had" — a claim about the run made from an unreadable answer.
  const { markup } = await renderExperiencePage({
    override: (path) => {
      if (!/\/experiences\/[^/?]+\/outcomes\b/u.test(path)) return undefined;
      const { correlationToken: _token, ...tokenless } = injection(true);
      return evidencePage("autodev-memory-injection-outcomes-v1", [
        OUTCOME_ROW,
        {
          injection: { ...tokenless, id: "inj-2" },
          outcome: null,
          sessionInjectionCount: 3
        }
      ]);
    }
  });

  assert.match(
    markup,
    /data-status="unavailable" data-evidence="outcomes"/u,
    "a page with an unaddressable row must report itself unread, not partial"
  );
  assert.doesNotMatch(
    markup,
    /data-evidence-row="inj-1"/u,
    "no row may render beside a refused page"
  );
});
test("a failed session-outcome read is not drawn as a session with no outcome", async () => {
  // The page half of a three-way distinction the panel depends on: `null` is
  // "the Runtime says none exists", `undefined` is "we could not read".
  //
  // The component's half was already pinned, so this was the layer that could
  // still fold a failed read into the empty state — and that failure invites an
  // operator to file a report for a session the Runtime may already have one
  // for, which comes back a conflict, against a panel that said there was
  // nothing there.
  const { markup } = await renderExperiencePage({
    fail: (path) => /\/experiences\/[^/?]+\/session-outcomes\b/u.test(path)
  });

  assert.match(
    markup,
    new RegExp(`data-status="unavailable"[^>]*>\\s*[^<]*was not read`, "u"),
    "a failed read must render as unreadable, not empty"
  );
  assert.doesNotMatch(
    markup,
    /name="action" value="report-session-outcome"/u,
    "an unreadable session outcome must not offer a report form"
  );
});
