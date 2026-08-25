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
  const perRepository = Object.fromEntries(repositories.map((name) => [name, {
    agentPrsRaised: 0,
    agentPrsMerged: 0,
    agentInvokes: emptyCounter(),
    staleEmptyPrsClosed: 0,
  }]));
  const perAgent = Object.fromEntries(AGENT_NAMES.map((name) => [name, emptyCounter()]));
  const invocationRuns = new Map();
  const recentPrs = [];
  let agentPrsRaised = 0;
  let agentPrsMerged = 0;
  let staleEmptyPrsClosed = 0;

  for (const fullName of repositories) {
    const [targetOwner, targetRepo] = fullName.split('/');
    const pulls = await listRecentPulls({ github, owner: targetOwner, repo: targetRepo, sinceDate });

    for (const summary of pulls) {
      const createdRecently = new Date(summary.created_at) >= sinceDate;
      const closedRecently = summary.state === 'closed' && summary.closed_at && new Date(summary.closed_at) >= sinceDate;
      const agent = agentFromPull(summary);
      if (!createdRecently && !closedRecently) continue;
      if (!agent && !closedRecently) continue;

      const comments = await github.paginate(github.rest.issues.listComments, {
        owner: targetOwner,
        repo: targetRepo,
        issue_number: summary.number,
        per_page: 100,
      });
      if (closedRecently && comments.some((comment) =>
        String(comment.body || '').includes(JANITOR_MARKER) || /Closing automatically: this PR has been open/i.test(comment.body || '')
      )) {
        perRepository[fullName].staleEmptyPrsClosed += 1;
        staleEmptyPrsClosed += 1;
      }
      if (!agent || !createdRecently) continue;

      const { data: pull } = await github.rest.pulls.get({ owner: targetOwner, repo: targetRepo, pull_number: summary.number });
      agentPrsRaised += 1;
      perRepository[fullName].agentPrsRaised += 1;
      if (pull.merged_at) {
        agentPrsMerged += 1;
        perRepository[fullName].agentPrsMerged += 1;
      }
      recentPrs.push({
        repository: fullName,
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        state: pull.state,
        createdAt: pull.created_at,
        mergedAt: pull.merged_at,
        agent,
      });

      for (const comment of comments) {
        const invocation = parseInvocationComment(comment.body);
        if (!invocation || invocationRuns.has(invocation.runId)) continue;
        let conclusion = 'unknown';
        try {
          const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo: autoDevRepo, run_id: invocation.runId });
          conclusion = run.conclusion || run.status || 'unknown';
        } catch (error) {
          if (globalThis.core?.warning) globalThis.core.warning(`Could not read AutoDev run ${invocation.runId}: ${error.message}`);
          else console.warn(`Could not read AutoDev run ${invocation.runId}: ${error.message}`);
        }
        invocationRuns.set(invocation.runId, { ...invocation, conclusion, repository: fullName });
      }
    }
  }

  for (const invocation of invocationRuns.values()) {
    addInvocation(perRepository[invocation.repository].agentInvokes, invocation.conclusion);
    if (!perAgent[invocation.agent]) perAgent[invocation.agent] = emptyCounter();
    addInvocation(perAgent[invocation.agent], invocation.conclusion);
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
      agentInvokes: Object.values(perRepository).reduce((sum, item) => sum + item.agentInvokes.total, 0),
      agentInvokesSucceeded: Object.values(perRepository).reduce((sum, item) => sum + item.agentInvokes.succeeded, 0),
      agentInvokesFailed: Object.values(perRepository).reduce((sum, item) => sum + item.agentInvokes.failed, 0),
      staleEmptyPrsClosed,
    },
    perRepository,
    perAgent,
    recentPrs: recentPrs.slice(0, 10),
  };
}

function renderDashboard(metrics) {
  const generated = metrics.generatedAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  const lines = [
    '<!-- autodev-metrics-dashboard-v1 -->',
    '# AutoDev metrics dashboard',
    '',
    `Generated: ${generated}`,
    `Lookback window: ${metrics.lookbackDays || 90} days (since ${metrics.since || 'rolling window'})`,
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
    '| Repository | PRs raised | PRs merged | Invokes | Succeeded | Failed | Stale closed |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [repository, item] of Object.entries(metrics.perRepository)) {
    lines.push(`| ${repository} | ${item.agentPrsRaised} | ${item.agentPrsMerged} | ${item.agentInvokes.total} | ${item.agentInvokes.succeeded} | ${item.agentInvokes.failed} | ${item.staleEmptyPrsClosed} |`);
  }
  lines.push('', '## Per agent', '', '| Agent | Invokes | Succeeded | Failed |', '|---|---:|---:|---:|');
  for (const [agent, item] of Object.entries(metrics.perAgent)) lines.push(`| ${agent} | ${item.total} | ${item.succeeded} | ${item.failed} |`);
  lines.push('', '## Last 10 agent PRs', '');
  if (!metrics.recentPrs.length) lines.push('_No agent PRs found._');
  else for (const pr of metrics.recentPrs) lines.push(`- [${pr.repository}#${pr.number}: ${pr.title}](${pr.url}) — ${pr.agent}, ${pr.state}${pr.mergedAt ? ', merged' : ''}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { AGENT_NAMES, JANITOR_MARKER, agentFromPull, isAgentPull, parseInvocationComment, collectMetrics, renderDashboard };
