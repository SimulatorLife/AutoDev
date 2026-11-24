# GitHub PR delivery mode for local AutoDev

## Context

`docs/TODO.md:88` asks for a GitHub-based flow. Today every agent edits one shared checkout, children never commit, and the root commits straight to `main` (lifecycle §8). The new flow:

1. The orchestrator and explorer read locally.
2. A worker pushes to a PR.
3. Validators review it with comments and a verdict.
4. The worker addresses and replies to every comment, and the loop repeats until a validator approves.
5. The orchestrator merges.
6. The orchestrator pulls.

Local mode stays.

Decisions:

- **Mode switch:** a per-workspace `delivery: "local" | "github-pr"` field.
- **GitHub access:** the official GitHub MCP server.
- **Identity:** one token. Validators post **COMMENT** reviews carrying a machine-readable verdict, because GitHub forbids self-approval.
- **GitHub Issues:** deferred to a follow-up TODO.

**Validation is CI-first.** The repository's PR workflows run the tests and validations, so workers and validators don't run slow suites locally:

- The worker pushes, opens the PR and returns at once. It doesn't wait on CI, and its slot frees up immediately.
- The validator reviews the diff while CI runs.
- The orchestrator waits for CI with a single bounded call, and routes any failures back to a worker.
- Local checks are limited to fast, targeted ones, such as a repro for a bug fix.
- The merge gate requires CI success. A workspace with no PR checks is **blocked**: configure CI for it or use local delivery.

Constraint: the CI agent workflows (`agent-invoke.yml` `@agent` comments, `target-automerge.yml` with the `agent` label and provider branch prefixes, `target-pr-janitor.yml`) must not pick these PRs up. Local PRs therefore use `autodev/<slug>` branches, no `agent` label, and no `@agent` mentions.

## Steps

### 0. Pin the GitHub MCP server

- Install `github-mcp-server` v2.2.0.
- Run `tools/list` with `--toolsets pull_requests`.
- Commit the tool, method and event enums as `tests/fixtures/github-mcp-server/v2.2.0-tools.json`.
- The README lists consolidated tools: `pull_request_read`, `pull_request_review_write` (create/submit_pending/delete_pending/resolve_thread), `add_comment_to_pending_review`, `add_reply_to_pull_request_comment`, `create_pull_request`, `update_pull_request`, `merge_pull_request` (`expectedHeadSha`). The exact method strings still need to be confirmed against `tools/list`.

### 1. Delivery field in the workspace catalog

- `core/src/workspaces/types.ts`: add `WORKSPACE_DELIVERY_MODES` and `WorkspaceDelivery`, and add `delivery` to `WorkspaceEntry`.
- `data/src/config/workspace-catalog.ts` (stays free of imports):
  - make the field required in `readWorkspaceEntry`;
  - accept it in the update path (`WorkspaceCatalogUpdate`, `WorkspaceCatalogField`, `changedFields`);
  - update the header doc.
- Keep schema `autodev-workspaces-v1`. Migrate all entries in the same commit, with no optional or legacy path.
- `config/workspaces.json`: add `"delivery": "local"` to all 5 entries. `data/src/config/config-repository.ts`: project the field.
- Update every catalog fixture (`git grep -l agentRoles` across runtime, console, data, core and the root tests). Add a test that the data and core constants match.

### 2. Control API and Console selector

- `core/src/control-api/types.ts`: add the field to the update body.
- `runtime/src/control-api/request-handler.ts` (~L2315): accept and validate `delivery`.
- Console:
  - `WorkspaceConfigurationForm.ts`: a select;
  - `console/app/api/workspaces/[owner]/[repository]/route.ts`: parse the field;
  - `console/src/lib/server/control-api.ts`: add it to the response guard;
  - `WorkspacesView.ts`: display the mode.
- Tests: control-api workspace mutation, the console route and control tests, and the workspaces e2e. Update `docs/autodev-console-target-state.md`.

### 3. Pure policy in core: `core/src/delivery/github-pr.ts`

- **Verdict marker:** `<!-- autodev-review v=1 verdict=approve|request-changes head=<sha> round=<n> -->`, with format and parse functions.
- **Addressed-reply marker:** `<!-- autodev-addressed v=1 commit=<sha> -->`, with format and parse functions.
- **Branches:** `AUTODEV_PR_BRANCH_PREFIX = "autodev/"` and `isAutodevPrBranch`.
- **`evaluateMergeGate(state, policy)`** returns merge, wait or blocked, with reasons and `expectedHeadSha`. All of these must hold:
  - the PR is open and not a draft;
  - base is the workspace base branch and head is `autodev/*`;
  - the PR is mergeable;
  - `reviewDecision` is not `CHANGES_REQUESTED` (human veto);
  - the latest marker verdict for the **current head SHA** is approve;
  - every thread is resolved, or its last comment carries the addressed marker;
  - the check rollup is `SUCCESS`. Pending or expected means wait. Failure or error means blocked, and the reasons list the failing check names. No checks at all means blocked with "no CI checks reported" once a grace period after the head push has passed; before that it means wait.
- **`nextReviewRoundDecision(round, max = 3)`** returns continue or escalate.
- Tests: `core/tests/github-pr-delivery.test.ts` (stale-head approve, a later request-changes overriding an approve, unreplied threads, check states, draft, wrong base, round escalation, marker round-trip).

### 4. Declare the GitHub MCP server and its credential

- `.rulesync/mcp.jsonc`: declare `github` under `codexcli` only, using `run-autodev-mcp.sh github`. Set `null` under `copilotcli`.
- `runtime/src/mcp/launcher.ts`:
  - add `github` to `McpName`, with `resolveGitHubMcpBinary` in `runtime/src/shared/executables.ts`;
  - args: `stdio --toolsets pull_requests,actions`. The `actions` toolset is only for reading failed job logs; the hook denies its write tools (rerun, dispatch, cancel);
  - read `AUTODEV_GITHUB_TOKEN` via `readRuntimeSecret`. If it is missing, exit 2 with a clear message (fail closed, no `gh auth` fallback);
  - pass the token only as `GITHUB_PERSONAL_ACCESS_TOKEN` in the child env, and strip any inherited `GITHUB_TOOLSETS`.
- `enabled_tools` per role in `agents/roles/*.toml`:

  | Role             | `enabled_tools`                                                                                               |
  | ---------------- | ------------------------------------------------------------------------------------------------------------- |
  | orchestrator     | read, list/search, merge, review_write (the hook limits it to thread resolve), actions job-log read           |
  | explorer         | read, list/search                                                                                             |
  | worker           | read, list, create_pull_request, update_pull_request, add_reply_to_pull_request_comment, actions job-log read |
  | validator        | read, pull_request_review_write, add_comment_to_pending_review                                                |
  | every other role | `enabled = false`, stated explicitly                                                                          |

- `render-execution-contract.ts`: add `github` to `MCP_ORDER`, then regenerate `config/execution-contract.json`.
- Tests:
  - `tests/config/mcp-launcher.test.ts`;
  - config rendering and the portable contract fixture;
  - every role declares `github`;
  - each role's `enabled_tools` ⊆ the step 0 fixture;
  - the bridge catalogue and bridge-role tests.

### 5. Runtime delivery resolver and PR state reader

- New `runtime/src/shared/repository-identity.ts`: move `repositoryIdentity` there from `runtime/src/router/http.ts`, and have the router import it.
- New `runtime/src/delivery/workspace-delivery.ts`:
  - `workspaceIdForDirectory(cwd)` reads the git origin and returns `owner/repo`;
  - `resolveWorkspaceDelivery()` returns one of `local`, `github-pr {available | unavailable + reason}` or `unknown`. Availability means the token secret is present and the binary resolves.
- New `runtime/src/delivery/github-pr-state.ts`: `fetchPullRequestGateState()` makes one bounded GraphQL call with the same token. It reuses the query shape of `runtime/src/memory/git-curation.ts` `githubReferenceState`, extended with head/base OIDs, `mergeable`, reviews with commit OIDs, and each thread's last comment.
- In the same module, add `waitForPullRequestChecks({ owner, repo, number, headSha, timeoutMs })`. It makes one blocking call with internal backoff (starting at 15 s, capped), returns when the rollup for that head is terminal or the timeout passes, and returns the gate state plus a summary of failing checks (name, conclusion, details URL).
- Expose it as the typed CLI command `pnpm autodev -- pr wait-checks <owner/repo> <number> --head <sha> [--timeout 30m]` in `runtime/src/cli/`. The command prints JSON. The orchestrator runs it as one `exec` cell with the `// @exec: {"yield_time_ms"}` pragma, so it waits once instead of polling across turns. Its read is allowed for the root; add it to the hook policy's allowed command set.
- `runtime/src/platform/install-materializer.ts`: add every new `runtime/src` file to `RUNTIME_MODULES` **and `git add` it** (otherwise `~/.codex` crash-loops).
- Tests: `runtime/tests/workspace-delivery.test.ts` (temp repo and catalog) and `runtime/tests/github-pr-state.test.ts` (stubbed fetch).

### 6. Hook enforcement

Codex `default.rules` prefix patterns cannot glob `autodev/*`, so the work is split in two: the rules only lift the sandbox, and the hook decides what is allowed.

- **New `runtime/src/agents/git-publication-policy.ts`** (pure; reuses `tokenize`/`splitSegments` from `read-only-policy.ts`):
  - **`git push`:** allowed only in github-pr mode with GitHub available, and only as `git push [-u] origin HEAD:refs/heads/autodev/<slug>`. Denied for force, a `+` refspec, delete, `--all`/`--mirror`/`--tags`, a bare push, the base branch as target, and validator or explorer callers.
  - **`git commit`:** in github-pr mode, denied while on the base branch.
  - **`git pull`:** only `--ff-only`, only by the root, only on the base branch.
- **New `runtime/src/agents/github-mcp-policy.ts`:**
  - **validator:** review_write only with the create, submit_pending and delete_pending methods, `event=COMMENT`, and a body starting with a valid verdict marker;
  - **root:** review_write only for `resolve_thread` / `unresolve_thread`;
  - **`create_pull_request`:** head must be `autodev/*` and base must equal the workspace base branch;
  - **`update_pull_request`:** no changes to state or base;
  - **`add_reply_to_pull_request_comment`:** must carry the addressed marker;
  - **`merge_pull_request`:** root only. The hook fetches the gate state and calls `evaluateMergeGate`, and `expectedHeadSha` must match.
- **`runtime/src/hooks/role-sandbox.ts`:** run both policies for every role and the root, but only on in-scope commands and tools. An internal error on an in-scope call **denies** it; the hook's existing top-level catch fails open. Add `git-publication` and `github-pr` to `HookDenialPolicy`.
- **`agents/rules/default.rules`:** add allow rules for `git push origin`, `git push -u|--set-upstream origin`, `git fetch origin`, `git pull --ff-only`, and `git worktree remove`. Keep force-push forbidden.
- **`config/config.autodev.toml`:** add `~/.autodev/worktrees` to `writable_roots`.
- Tests:
  - `tests/config/command-rules.test.ts`;
  - new policy table tests, including `git push origin main`, `HEAD:main`, a `+` refspec, chained pushes, and a commit on base;
  - the role-sandbox hook test (fail-closed on error, gate reasons surfaced).

### 7. Bootstrap tells the root which mode applies

- The delivery-mode section belongs to the orchestration skill's `github-pr-lifecycle.md` reference, which Rulesync projects to every target:
  - **local:** "commit to base per §8";
  - **github-pr:** "use `github-pr-lifecycle.md`; never commit to base";
  - **github-pr unavailable:** "BLOCKED: <reason>; do not implement; tell the user";
  - **unknown:** nothing appended.
- No hook injects the delivery mode into a prompt. The root-delegation hook that used to resolve it from `cwd` is gone, and the root bootstrap module it read was removed with it.
- Preserve the delivery-mode policy across native ACP continuation/compaction through the current trusted role/workspace bootstrap. Do not restore the retired Responses proxy bootstrap-recovery path.
- Tests: native ACP continuation and role/workspace policy acceptance.

### 8. Policy docs, skill and prompts

- **New `.rulesync/skills/orchestration/references/github-pr-lifecycle.md`:**
  1. Explore locally.
  2. Root runs `git fetch origin` and `git worktree add --detach ~/.autodev/worktrees/<owner>/<repo>/<slug> origin/<base>`. This keeps the shared checkout on base and leaves no local branch to delete. The worker implements, runs only fast targeted checks (no full suite and no dependency install unless a targeted check needs it), commits (no amend), pushes `HEAD:refs/heads/autodev/<slug>`, creates the PR, and **returns immediately** with the PR number and head SHA. It does not wait on CI.
  3. In parallel:
     - A validator reviews the diff and the contract: pending review, comments, then submit with COMMENT and a verdict marker for the head SHA. It does not rerun what CI covers; it may run a targeted repro only when CI can't show something.
     - The root runs `autodev pr wait-checks` for that head.
     - The two together use at most 2 child slots.
  4. Requested changes and CI failures both go back to a worker in one batch. That is the parked worker if it is still alive, or a fresh one in the same worktree. The batch holds:
     - the review thread IDs;
     - the failing checks, with a log excerpt from the actions job-log tool.

     The worker fixes, pushes, and replies to **every** review thread with the marker plus What/How/Where (`path:line`, commit). CI fixes are summarised in a single PR comment. On the new head, the root starts the next round: the validator reviews only the delta since the last approved head, and wait-checks runs again.

  5. When the gate says merge (verdict approve and CI green for the same head), the root resolves threads and merges (squash, `expectedHeadSha`).
  6. Root runs `git pull --ff-only` and `git worktree remove`.

  After 3 rounds, escalate to the user, listing the open threads and failing checks.

- **New leaf skill `.rulesync/skills/github-pr-delivery/SKILL.md`:** the child contract (refspec, commit rules, reply format, verdict grammar, COMMENT-only reviews). Enable it for the worker, validator and orchestrator, and set it explicitly disabled elsewhere. Add it to `SKILL_ORDER`.
- **Orchestration references:** add a row to the `SKILL.md` reference table; update `runtime-contract.md` §Commits (the root never commits in github-pr mode, plus the new allowed commands), point `development-lifecycle.md` §8 to the new lifecycle, and update `validation.md`: in github-pr mode, CI is the test and validation evidence, the validator's report is the submitted review, and validators don't duplicate CI locally.
- **Prompts:**
  - `agents/prompts/roles/worker.md` and `validator.md`: keep the no-push/no-PR default, except "when the parent assigns github-pr delivery, follow the `github-pr-delivery` skill";
  - `explorer.md`: may read PRs.
- Test: a test that the marker examples in the docs parse with the core parsers.

### 9. Install check, docs, TODO

- `runtime/src/platform/install-check.ts`: when any workspace is `github-pr`, report whether the token is present (presence only), whether the binary resolves, and its version. Add tests.
- `README.md`: add a "Delivery modes" note.
- `docs/local-setup.md`:
  - new section "GitHub PR delivery": `AUTODEV_GITHUB_TOKEN` in the runtime secret file with fine-grained contents, PR and checks permissions; installing the binary; the `delivery` field; the worktree location; the self-approval and branch-protection caveat; enabling "auto-delete head branches";
  - update the command-rules and role-sandbox sections.
- `docs/organization-routing.md`: explain that `autodev/*` PRs sit outside the CI agent namespace.
- `docs/TODO.md:88`: tick it with a summary, and add a new FEAT entry for GitHub Issues integration.

## Risks to check during implementation

- Whether a Codex child's `enabled_tools` replaces or merges the root's list. Verify with request capture.
- Whether PreToolUse hooks see MCP calls on the bridged providers (Claude, Copilot, Antigravity).
- A token-less session logs a non-fatal startup warning for the root `github` server. This is documented; no stub server is added.
- Repos whose branch protection requires approving reviews can't merge with one token. This is documented.
- LSP and code-search indexes stay bound to the main checkout, not the PR worktree.

## Verification

1. `pnpm run typecheck && pnpm run lint && pnpm test`, plus `bash scripts/install.sh --check`.
2. Isolated install (`CODEX_HOME=$(mktemp -d)`). Inspect `config.toml`, `agents/*.toml` and `provider-runtime/mcp-servers.json`. Confirm `run-autodev-mcp.sh github` exits 2 without the token, and that its `tools/list` matches the fixture with the token.
3. Request capture (`autodev-request-capture` skill): check each role's advertised GitHub tools, and the bootstrap delivery and BLOCKED sections.
4. Live run against a private scratch repo set to `delivery: "github-pr"`. The entry is local only and not committed. Check for:
   - a worktree, an `autodev/<slug>` push, and a PR with no `agent` label;
   - the worker returns before CI finishes, and the validator review overlaps the CI run;

- wait-checks returns after a single call;
- an injected CI failure is routed back to a worker with the failing check and a log excerpt;
- a COMMENT review with a marker;
- a forced request-changes round, with marked replies on every thread;
- a premature merge denied with reasons, then a successful merge;
- a fast-forward of the shared checkout, and the worktree removed.

Negative probes: `git push origin main`, a root commit on base, and a validator `event=APPROVE` must all be denied. Then switch the entry back to `local` and confirm the old flow is unchanged. Collect evidence with `autodev-session-diagnostics`.
