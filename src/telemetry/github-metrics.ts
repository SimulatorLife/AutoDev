export const AGENT_NAMES = [
  "copilot",
  "claude",
  "codex",
  "gemini",
  "qwen",
  "mini-max",
  "mini-max-codex"
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

const AGENT_BRANCH =
  /^(copilot|claude|codex|gemini|qwen|mini-max|mini-max-codex)(?:\/|$)/i;
const AGENT_TITLE_PREFIX_PATTERN = /^(?:Agent|Codex):\s/i;
const INVOCATION_COMMENT_PATTERN =
  INVOCATION_COMMENT_PATTERNu;
const LINE_SPLIT_PATTERN = /\r?\n/;
const TIMESTAMP_SUFFIX_PATTERN = /\.\d{3}Z\$/;
const COLLATOR = new Intl.Collator("en");
export const JANITOR_MARKER = "<!-- autodev-target-pr-janitor -->";

export interface InvocationComment {
  agent: string;
  runId: number;
}

export interface InvocationCounter {
  total: number;
  succeeded: number;
  failed: number;
  other: number;
}

export interface PullLabel {
  name?: string;
}

export interface PullHead {
  ref?: string;
}

export interface PullLike {
  title?: string;
  labels?: PullLabel[];
  head?: PullHead;
  [key: string]: unknown;
}

export interface PullSummary extends PullLike {
  number: number;
  title: string;
  html_url: string;
  state: string;
  created_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
}

export interface RecentPr {
  repository: string;
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  mergedAt: string | null | undefined;
  agent: string;
}

export interface RepositoryMetrics {
  agentPrsRaised: number;
  agentPrsMerged: number;
  agentInvokes: InvocationCounter;
  staleEmptyPrsClosed: number;
}

export interface CollectedMetrics {
  schema: "autodev-metrics-v1";
  generatedAt: string;
  lookbackDays: number;
  since: string;
  repositories: string[];
  totals: {
    agentPrsRaised: number;
    agentPrsMerged: number;
    agentInvokes: number;
    agentInvokesSucceeded: number;
    agentInvokesFailed: number;
    staleEmptyPrsClosed: number;
  };
  perRepository: Record<string, RepositoryMetrics>;
  perAgent: Record<string, InvocationCounter>;
  recentPrs: RecentPr[];
}

export interface ListRecentPullsOptions {
  github: {
    rest: {
      pulls: {
        list: (params: {
          owner: string;
          repo: string;
          state: string;
          per_page: number;
          page: number;
          sort: "created";
          direction: "desc";
        }) => Promise<{ data: PullSummary[] }>;
      };
    };
  };
  owner: string;
  repo: string;
  sinceDate: Date;
}

export interface CollectMetricsOptions {
  github: {
    paginate: <T>(
      method: unknown,
      params: Record<string, unknown>
    ) => Promise<T[]>;
    rest: {
      actions: {
        listWorkflowRuns: unknown;
      };
      pulls: {
        list: (params: {
          owner: string;
          repo: string;
          state: string;
          per_page: number;
          page: number;
          sort: "created";
          direction: "desc";
        }) => Promise<{ data: PullSummary[] }>;
      };
    };
  };
  owner: string;
  autoDevRepo: string;
  repositories: string[];
  lookbackDays?: number;
  generatedAt?: string;
}

export function normalizeAgent(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (AGENT_NAMES as readonly string[]).includes(normalized)
    ? normalized
    : "";
}

export function agentFromPull(pull: PullLike): string {
  const label = (pull.labels ?? [])
    .map((item) => normalizeAgent(item.name))
    .find(Boolean);
  if (label) return label;
  const branchMatch = String(pull.head?.ref ?? "").match(AGENT_BRANCH);
  if (branchMatch?.[1]) return normalizeAgent(branchMatch[1]);
  if (AGENT_TITLE_PREFIX_PATTERN.test(pull.title ?? "")) return "unknown";
  return "";
}

export function isAgentPull(pull: PullLike): boolean {
  return Boolean(agentFromPull(pull));
}

export function parseInvocationComment(
  body: unknown
): InvocationComment | null {
  const match = INVOCATION_COMMENT_PATTERN.exec(String(body ?? ""));
  if (!match?.[1] || !match[2]) return null;
  return {
    agent: normalizeAgent(match[1]) || match[1].trim().toLowerCase(),
    runId: Number(match[2])
  };
}

export function listRecentPulls({
  github,
  owner,
  repo,
  sinceDate
}: ListRecentPullsOptions): Promise<PullSummary[]> {
  return fetchRecentPullPages({ github, owner, repo, sinceDate }, [], 1);
}

async function fetchRecentPullPages(
  options: ListRecentPullsOptions,
  acc: PullSummary[],
  page: number
): Promise<PullSummary[]> {
  if (page > 50) return acc;
  const { data } = await options.github.rest.pulls.list({
    owner: options.owner,
    repo: options.repo,
    state: "all",
    per_page: 100,
    page,
    sort: "created",
    direction: "desc"
  });
  const next = [...acc, ...data];
  const last = data.at(-1);
  if (data.length < 100 || (last && new Date(last.created_at) < options.sinceDate))
    return next;
  return fetchRecentPullPages(options, next, page + 1);
}

function emptyCounter(): InvocationCounter {
  return { total: 0, succeeded: 0, failed: 0, other: 0 };
}

function addInvocation(counter: InvocationCounter, conclusion: string): void {
  counter.total += 1;
  if (conclusion === "success") counter.succeeded += 1;
  else if (conclusion === "failure") counter.failed += 1;
  else counter.other += 1;
}

interface CollectProviderInvocationsContext {
  providerWorkflows: ReadonlyArray<[string, string]>;
  github: CollectMetricsOptions["github"];
  owner: string;
  autoDevRepo: string;
  since: string;
  perAgent: Record<string, InvocationCounter>;
  perRepository: Record<string, RepositoryMetrics>;
  repositories: string[];
}

async function collectProviderWorkflow(
  context: CollectProviderInvocationsContext,
  index: number
): Promise<void> {
  if (index >= context.providerWorkflows.length) return;
  const entry = context.providerWorkflows[index];
  if (!entry) return;
  const [workflowId, agent] = entry;
  const runs = await context.github.paginate<WorkflowRunItem>(
    context.github.rest.actions.listWorkflowRuns,
    {
      owner: context.owner,
      repo: context.autoDevRepo,
      workflow_id: workflowId,
      created: `>=${context.since}`,
      per_page: 100
    }
  );
  for (const run of runs) {
    const outcome = run.conclusion || run.status || "unknown";
    const agentCounter = context.perAgent[agent];
    if (agentCounter) addInvocation(agentCounter, outcome);
    const runTitle = run.display_title ?? "";
    const target = context.repositories.find((repository) =>
      runTitle.includes(repository)
    );
    if (target && context.perRepository[target]) {
      addInvocation(context.perRepository[target].agentInvokes, outcome);
    } else if (context.perAgent.unattributed) {
      addInvocation(context.perAgent.unattributed, outcome);
    }
  }
  await collectProviderWorkflow(context, index + 1);
}

function collectProviderInvocations(
  context: CollectProviderInvocationsContext
): Promise<void> {
  return collectProviderWorkflow(context, 0);
}

interface CollectRepositoryPullsContext {
  repositories: string[];
  github: CollectMetricsOptions["github"];
  sinceDate: Date;
  perRepository: Record<string, RepositoryMetrics>;
  recentPrs: RecentPr[];
  mutateTotals: {
    bumpRaised: () => number;
    bumpMerged: () => number;
    bumpStale: () => number;
  };
}

async function collectRepository(
  context: CollectRepositoryPullsContext,
  index: number,
  sinceDate: Date
): Promise<void> {
  if (index >= context.repositories.length) return;
  const fullName = context.repositories[index];
  if (fullName === undefined) return;
  const [targetOwner, targetRepo] = fullName.split("/");
  if (!targetOwner || !targetRepo) {
    await collectRepository(context, index + 1, sinceDate);
    return;
  }
  const pulls = await listRecentPulls({
    github: context.github,
    owner: targetOwner,
    repo: targetRepo,
    sinceDate
  });
  applyPullsToTotals(context, sinceDate, fullName, pulls);
  await collectRepository(context, index + 1, sinceDate);
}

function applyPullsToTotals(
  context: CollectRepositoryPullsContext,
  sinceDate: Date,
  fullName: string,
  pulls: PullSummary[]
): void {
  for (const summary of pulls) {
    const createdRecently = new Date(summary.created_at) >= sinceDate;
    const closedRecently =
      summary.state === "closed" &&
      summary.closed_at &&
      new Date(summary.closed_at) >= sinceDate;
    if (
      closedRecently &&
      (summary.labels ?? []).some(
        (label) => label.name === "autodev-stale-closed"
      )
    ) {
      const repoEntry = context.perRepository[fullName];
      if (repoEntry) repoEntry.staleEmptyPrsClosed += 1;
      context.mutateTotals.bumpStale();
    }
    const agent = agentFromPull(summary);
    if (!agent || !createdRecently) continue;
    context.mutateTotals.bumpRaised();
    const repoEntry = context.perRepository[fullName];
    if (repoEntry) repoEntry.agentPrsRaised += 1;
    if (summary.merged_at) {
      context.mutateTotals.bumpMerged();
      if (repoEntry) repoEntry.agentPrsMerged += 1;
    }
    context.recentPrs.push({
      repository: fullName,
      number: summary.number,
      title: summary.title,
      url: summary.html_url,
      state: summary.state,
      createdAt: summary.created_at,
      mergedAt: summary.merged_at,
      agent
    });
  }
}

function collectRepositoryPulls(
  context: CollectRepositoryPullsContext
): Promise<void> {
  return collectRepository(context, 0, context.sinceDate);
}

interface WorkflowRunItem {
  conclusion?: string | null;
  status?: string | null;
  display_title?: string | null;
}

export async function collectMetrics({
  github,
  owner,
  autoDevRepo,
  repositories,
  lookbackDays = 90,
  generatedAt = new Date().toISOString()
}: CollectMetricsOptions): Promise<CollectedMetrics> {
  const sinceDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const since = sinceDate.toISOString().slice(0, 10);
  const providerWorkflows: Array<[string, string]> = [
    ["claude-invoke.yml", "claude"],
    ["gemini-invoke.yml", "gemini"],
    ["qwen-invoke.yml", "qwen"],
    ["minimax-invoke.yml", "mini-max"],
    ["minimax-codex-invoke.yml", "mini-max-codex"]
  ];
  const perRepository: Record<string, RepositoryMetrics> = Object.fromEntries(
    repositories.map((name) => [
      name,
      {
        agentPrsRaised: 0,
        agentPrsMerged: 0,
        agentInvokes: emptyCounter(),
        staleEmptyPrsClosed: 0
      }
    ])
  );
  const perAgent: Record<string, InvocationCounter> = Object.fromEntries(
    [...AGENT_NAMES, "unattributed"].map((name) => [name, emptyCounter()])
  );
  const recentPrs: RecentPr[] = [];
  let agentPrsRaised = 0;
  let agentPrsMerged = 0;
  let staleEmptyPrsClosed = 0;

  await collectProviderInvocations({
    providerWorkflows,
    github,
    owner,
    autoDevRepo,
    since,
    perAgent,
    perRepository,
    repositories
  });

  await collectRepositoryPulls({
    repositories,
    github,
    sinceDate,
    perRepository,
    recentPrs,
    mutateTotals: {
      bumpRaised: () => {
        agentPrsRaised += 1;
        return agentPrsRaised;
      },
      bumpMerged: () => {
        agentPrsMerged += 1;
        return agentPrsMerged;
      },
      bumpStale: () => {
        staleEmptyPrsClosed += 1;
        return staleEmptyPrsClosed;
      }
    }
  });

  recentPrs.sort((left, right) =>
    COLLATOR.compare(right.createdAt, left.createdAt)
  );
  return {
    schema: "autodev-metrics-v1",
    generatedAt,
    lookbackDays,
    since,
    repositories,
    totals: {
      agentPrsRaised,
      agentPrsMerged,
      agentInvokes: Object.values(perAgent).reduce(
        (sum, item) => sum + item.total,
        0
      ),
      agentInvokesSucceeded: Object.values(perAgent).reduce(
        (sum, item) => sum + item.succeeded,
        0
      ),
      agentInvokesFailed: Object.values(perAgent).reduce(
        (sum, item) => sum + item.failed,
        0
      ),
      staleEmptyPrsClosed
    },
    perRepository,
    perAgent,
    recentPrs: recentPrs.slice(0, 10)
  };
}

function formatTimestampToMinute(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short"
    })
      .formatToParts(date)
      .map(({ type, value: part }) => [type, part])
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute} ${parts.timeZoneName}`;
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replaceAll("|", String.raw`\|`)
    .replaceAll(LINE_SPLIT_PATTERN, " ");
}

export function renderDashboard(metrics: CollectedMetrics): string {
  const generated = metrics.generatedAt
    .replace("T", " ")
    .replace(TIMESTAMP_SUFFIX_PATTERN, " UTC");
  const lines = [
    "<!-- autodev-metrics-dashboard-v1 -->",
    "# AutoDev metrics dashboard",
    "",
    `Generated: ${generated}`,
    `Lookback window: ${metrics.lookbackDays || 90} days (since ${metrics.since || "rolling window"})`,
    "Provider-run per-repository attribution is available for runs carrying the target repository in their run name; older runs are shown as unattributed.",
    "",
    "## Totals",
    "",
    "| Metric | Count |",
    "|---|---:|",
    `| Agent PR-and-ping PRs raised | ${metrics.totals.agentPrsRaised} |`,
    `| Agent PRs successfully merged | ${metrics.totals.agentPrsMerged} |`,
    `| Agent invokes | ${metrics.totals.agentInvokes} |`,
    `| Successful agent invokes | ${metrics.totals.agentInvokesSucceeded} |`,
    `| Failed agent invokes | ${metrics.totals.agentInvokesFailed} |`,
    `| Stale-empty PRs closed | ${metrics.totals.staleEmptyPrsClosed} |`,
    "",
    "## Per repository",
    "",
    "| Repository | PRs raised | PRs merged | Invokes | Succeeded | Failed | Other | Stale closed |",
    "|---|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const [repository, item] of Object.entries(metrics.perRepository)) {
    lines.push(
      `| ${repository} | ${item.agentPrsRaised} | ${item.agentPrsMerged} | ${item.agentInvokes.total} | ${item.agentInvokes.succeeded} | ${item.agentInvokes.failed} | ${item.agentInvokes.other} | ${item.staleEmptyPrsClosed} |`
    );
  }
  lines.push(
    "",
    "## Per agent",
    "",
    "| Agent | Invokes | Succeeded | Failed | Other |",
    "|---|---:|---:|---:|---:|"
  );
  for (const [agent, item] of Object.entries(metrics.perAgent))
    lines.push(
      `| ${agent} | ${item.total} | ${item.succeeded} | ${item.failed} | ${item.other} |`
    );
  lines.push(
    "",
    "## Last 10 agent PRs",
    "",
    "| PR | Title | Repository | Created (EST5EDT) | Agent | State | Merged |",
    "|---|---|---|---|---|---|---|"
  );
  if (metrics.recentPrs.length === 0)
    lines.push("| _None_ |  |  |  |  |  |  |");
  else
    for (const pr of metrics.recentPrs)
      lines.push(
        `| [#${pr.number}](${pr.url}) | ${markdownCell(pr.title)} | ${markdownCell(pr.repository)} | ${formatTimestampToMinute(pr.createdAt)} | ${markdownCell(pr.agent)} | ${markdownCell(pr.state)} | ${pr.mergedAt ? "Yes" : "No"} |`
      );
  return `${lines.join("\n")}\n`;
}
