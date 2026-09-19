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
  if (/^(?:Agent|Codex):\s/i.test(pull.title ?? "")) return "unknown";
  return "";
}

export function isAgentPull(pull: PullLike): boolean {
  return Boolean(agentFromPull(pull));
}

export function parseInvocationComment(
  body: unknown
): InvocationComment | null {
  const match = String(body ?? "").match(
    /\*\*\[🤖\s*([^\]]+)\]\*\*\s+Hi, I've received[\s\S]*?actions\/runs\/(\d+)/i
  );
  if (!match?.[1] || !match[2]) return null;
  return {
    agent: normalizeAgent(match[1]) || match[1].trim().toLowerCase(),
    runId: Number(match[2])
  };
}

export async function listRecentPulls({
  github,
  owner,
  repo,
  sinceDate
}: ListRecentPullsOptions): Promise<PullSummary[]> {
  const pulls: PullSummary[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data } = await github.rest.pulls.list({
      owner,
      repo,
      state: "all",
      per_page: 100,
      page,
      sort: "created",
      direction: "desc"
    });
    pulls.push(...data);
    const last = data.at(-1);
    if (data.length < 100 || (last && new Date(last.created_at) < sinceDate))
      break;
  }
  return pulls;
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

  for (const [workflowId, agent] of providerWorkflows) {
    const runs = await github.paginate<WorkflowRunItem>(
      github.rest.actions.listWorkflowRuns,
      {
        owner,
        repo: autoDevRepo,
        workflow_id: workflowId,
        created: `>=${since}`,
        per_page: 100
      }
    );
    for (const run of runs) {
      const outcome = run.conclusion || run.status || "unknown";
      const agentCounter = perAgent[agent];
      if (agentCounter) addInvocation(agentCounter, outcome);
      const runTitle = run.display_title ?? "";
      const target = repositories.find((repository) =>
        runTitle.includes(repository)
      );
      if (target && perRepository[target]) {
        addInvocation(perRepository[target].agentInvokes, outcome);
      } else if (perAgent.unattributed) {
        addInvocation(perAgent.unattributed, outcome);
      }
    }
  }

  for (const fullName of repositories) {
    const [targetOwner, targetRepo] = fullName.split("/");
    if (!targetOwner || !targetRepo) continue;
    const pulls = await listRecentPulls({
      github,
      owner: targetOwner,
      repo: targetRepo,
      sinceDate
    });
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
        const repoEntry = perRepository[fullName];
        if (repoEntry) repoEntry.staleEmptyPrsClosed += 1;
        staleEmptyPrsClosed += 1;
      }
      const agent = agentFromPull(summary);
      if (!agent || !createdRecently) continue;
      agentPrsRaised += 1;
      const repoEntry = perRepository[fullName];
      if (repoEntry) repoEntry.agentPrsRaised += 1;
      if (summary.merged_at) {
        agentPrsMerged += 1;
        if (repoEntry) repoEntry.agentPrsMerged += 1;
      }
      recentPrs.push({
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

  recentPrs.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
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
    .replaceAll(/\r?\n/g, " ");
}

export function renderDashboard(metrics: CollectedMetrics): string {
  const generated = metrics.generatedAt
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
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
