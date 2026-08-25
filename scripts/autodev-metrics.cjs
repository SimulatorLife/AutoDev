const AGENT_NAMES = ['copilot', 'claude', 'codex', 'gemini', 'qwen', 'mini-max', 'mini-max-codex'];
const AGENT_BRANCH = /^(copilot|claude|codex|gemini|qwen|mini-max|mini-max-codex)(?:\/|$)/i;
const AGENT_LABEL = new Set(AGENT_NAMES);
const JANITOR_MARKER = '<!-- autodev-target-pr-janitor -->';

function normalizeAgent(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return AGENT_NAMES.includes(normalized) ? normalized : '';
}

function agentFromPull(pull) {
  const label = (pull.labels || []).map((item) => normalizeAgent(item.name)).find(Boolean);
  if (label) return label;
  const branchMatch = String(pull.head?.ref || '').match(AGENT_BRANCH);
  if (branchMatch) return normalizeAgent(branchMatch[1]);
  if (/^(?:Agent|Codex):\s/i.test(pull.title || '')) return 'unknown';
  return '';
}

function isAgentPull(pull) {
  return Boolean(agentFromPull(pull));
}

function parseInvocationComment(body) {
  const match = String(body || '').match(/\*\*\[🤖\s*([^\]]+)\]\*\*\s+Hi, I've received[\s\S]*?actions\/runs\/(\d+)/i);
  if (!match) return null;
  return { agent: normalizeAgent(match[1]) || match[1].trim().toLowerCase(), runId: Number(match[2]) };
}


async function listRecentPulls({ github, owner, repo, sinceDate }) {
  const pulls = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data } = await github.rest.pulls.list({
      owner,
      repo,
      state: 'all',
      per_page: 100,
      page,
      sort: 'created',
      direction: 'desc',
    });
    pulls.push(...data);
    if (data.length < 100 || new Date(data[data.length - 1].created_at) < sinceDate) break;
  }
  return pulls;
}

function emptyCounter() {
  return { total: 0, succeeded: 0, failed: 0, other: 0 };
}

function addInvocation(counter, conclusion) {
  counter.total += 1;
  if (conclusion === 'success') counter.succeeded += 1;
  else if (conclusion === 'failure') counter.failed += 1;
  else counter.other += 1;
}

async function collectMetrics({ github, owner, autoDevRepo, repositories, lookbackDays = 90, generatedAt = new Date().toISOString() }) {
  const sinceDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const since = sinceDate.toISOString().slice(0, 10);
  const providerWorkflows = [
    ['claude-invoke.yml', 'claude'],
    ['gemini-invoke.yml', 'gemini'],
    ['qwen-invoke.yml', 'qwen'],
    ['minimax-invoke.yml', 'mini-max'],
    ['minimax-codex-invoke.yml', 'mini-max-codex'],
  ];
  const perRepository = Object.fromEntries(repositories.map((name) => [name, {
    agentPrsRaised: 0,
    agentPrsMerged: 0,
    agentInvokes: emptyCounter(),
    staleEmptyPrsClosed: 0,
  }]));
  const perAgent = Object.fromEntries([...AGENT_NAMES, 'unattributed'].map((name) => [name, emptyCounter()]));
  const recentPrs = [];
  let agentPrsRaised = 0;
  let agentPrsMerged = 0;
  let staleEmptyPrsClosed = 0;

  // Workflow run names carry the target repository and PR number for all new provider invocations.
  for (const [workflowId, agent] of providerWorkflows) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      owner,
      repo: autoDevRepo,
      workflow_id: workflowId,
      created: `>=${since}`,
      per_page: 100,
    });
    for (const run of runs) {
      addInvocation(perAgent[agent], run.conclusion || run.status || 'unknown');
      const runTitle = run.display_title || '';
      const target = repositories.find((repository) => runTitle.includes(repository));
      if (target) addInvocation(perRepository[target].agentInvokes, run.conclusion || run.status || 'unknown');
      else addInvocation(perAgent.unattributed, run.conclusion || run.status || 'unknown');
    }
  }

  for (const fullName of repositories) {
    const [targetOwner, targetRepo] = fullName.split('/');
    const pulls = await listRecentPulls({ github, owner: targetOwner, repo: targetRepo, sinceDate });
    for (const summary of pulls) {
      const createdRecently = new Date(summary.created_at) >= sinceDate;
      const closedRecently = summary.state === 'closed' && summary.closed_at && new Date(summary.closed_at) >= sinceDate;
      if (closedRecently && (summary.labels || []).some((label) => label.name === 'autodev-stale-closed')) {
        perRepository[fullName].staleEmptyPrsClosed += 1;
        staleEmptyPrsClosed += 1;
      }
      const agent = agentFromPull(summary);
      if (!agent || !createdRecently) continue;
      agentPrsRaised += 1;
      perRepository[fullName].agentPrsRaised += 1;
      if (summary.merged_at) {
        agentPrsMerged += 1;
        perRepository[fullName].agentPrsMerged += 1;
      }
      recentPrs.push({
        repository: fullName,
        number: summary.number,
        title: summary.title,
        url: summary.html_url,
        state: summary.state,
        createdAt: summary.created_at,
        mergedAt: summary.merged_at,
        agent,
      });
    }
  }

  recentPrs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return {
    schema: 'autodev-metrics-v1',
    generatedAt,
    lookbackDays,
    since,
    repositories,
    totals: {
      agentPrsRaised,
      agentPrsMerged,
      agentInvokes: Object.values(perAgent).reduce((sum, item) => sum + item.total, 0),
      agentInvokesSucceeded: Object.values(perAgent).reduce((sum, item) => sum + item.succeeded, 0),
      agentInvokesFailed: Object.values(perAgent).reduce((sum, item) => sum + item.failed, 0),
      staleEmptyPrsClosed,
    },
    perRepository,
    perAgent,
    recentPrs: recentPrs.slice(0, 10),
  };
}

function formatTimestampToMinute(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function renderDashboard(metrics) {
  const generated = metrics.generatedAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  const lines = [
    '<!-- autodev-metrics-dashboard-v1 -->',
    '# AutoDev metrics dashboard',
    '',
    `Generated: ${generated}`,
    `Lookback window: ${metrics.lookbackDays || 90} days (since ${metrics.since || 'rolling window'})`,
    'Provider-run per-repository attribution is available for runs carrying the target repository in their run name; older runs are shown as unattributed.',
    '',
    '## Totals',
    '',
    '| Metric | Count |',
    '|---|---:|',
    `| Agent PR-and-ping PRs raised | ${metrics.totals.agentPrsRaised} |`,
    `| Agent PRs successfully merged | ${metrics.totals.agentPrsMerged} |`,
    `| Agent invokes | ${metrics.totals.agentInvokes} |`,
    `| Successful agent invokes | ${metrics.totals.agentInvokesSucceeded} |`,
    `| Failed agent invokes | ${metrics.totals.agentInvokesFailed} |`,
    `| Stale-empty PRs closed | ${metrics.totals.staleEmptyPrsClosed} |`,
    '',
    '## Per repository',
    '',
    '| Repository | PRs raised | PRs merged | Invokes | Succeeded | Failed | Other | Stale closed |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [repository, item] of Object.entries(metrics.perRepository)) {
    lines.push(`| ${repository} | ${item.agentPrsRaised} | ${item.agentPrsMerged} | ${item.agentInvokes.total} | ${item.agentInvokes.succeeded} | ${item.agentInvokes.failed} | ${item.agentInvokes.other} | ${item.staleEmptyPrsClosed} |`);
  }
  lines.push('', '## Per agent', '', '| Agent | Invokes | Succeeded | Failed | Other |', '|---|---:|---:|---:|---:|');
  for (const [agent, item] of Object.entries(metrics.perAgent)) lines.push(`| ${agent} | ${item.total} | ${item.succeeded} | ${item.failed} | ${item.other} |`);
  lines.push('', '## Last 10 agent PRs', '');
  if (!metrics.recentPrs.length) lines.push('_No agent PRs found._');
  else for (const pr of metrics.recentPrs) lines.push(`- [${pr.repository}#${pr.number}: ${pr.title}](${pr.url}) — created ${formatTimestampToMinute(pr.createdAt)}, ${pr.agent}, ${pr.state}${pr.mergedAt ? ', merged' : ''}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { AGENT_NAMES, JANITOR_MARKER, agentFromPull, isAgentPull, parseInvocationComment, collectMetrics, renderDashboard };
