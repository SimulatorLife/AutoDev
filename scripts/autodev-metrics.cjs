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
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const titlePrefixes = [
    { query: '"Agent:"', agent: 'unknown' },
    { query: '"Codex:"', agent: 'codex' },
    { query: '"MiniMax:"', agent: 'mini-max' },
    { query: '"Claude:"', agent: 'claude' },
    { query: '"Gemini:"', agent: 'gemini' },
    { query: '"Qwen:"', agent: 'qwen' },
    { query: '"Copilot:"', agent: 'copilot' },
  ];
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

  const search = async (query, perPage = 100) => github.paginate(github.rest.search.issuesAndPullRequests, { q: query, per_page: perPage });
  const count = async (query) => {
    const { data } = await github.rest.search.issuesAndPullRequests({ q: query, per_page: 1 });
    return Number(data.total_count || 0);
  };

  for (const fullName of repositories) {
    const baseQuery = `repo:${fullName} is:pr created:>=${since}`;
    const [janitorMatches, legacyJanitorMatches] = await Promise.all([
      search(`${baseQuery} is:closed "${JANITOR_MARKER}" in:comments`),
      search(`${baseQuery} is:closed "Closing automatically" in:comments`),
    ]);
    const janitorPrNumbers = new Set([
      ...janitorMatches.map((item) => item.number),
      ...legacyJanitorMatches.map((item) => item.number),
    ]);
    perRepository[fullName].staleEmptyPrsClosed = janitorPrNumbers.size;
    staleEmptyPrsClosed += janitorPrNumbers.size;

    const recentAgentPulls = new Map();
    for (const prefix of titlePrefixes) {
      const createdQuery = `${baseQuery} ${prefix.query} in:title`;
      const mergedQuery = `${createdQuery} is:merged`;
      const [createdCount, mergedCount, recent] = await Promise.all([
        count(createdQuery),
        count(mergedQuery),
        search(`${createdQuery} sort:created-desc`, 100),
      ]);
      agentPrsRaised += createdCount;
      agentPrsMerged += mergedCount;
      perRepository[fullName].agentPrsRaised += createdCount;
      perRepository[fullName].agentPrsMerged += mergedCount;
      for (const item of recent) recentAgentPulls.set(item.number, { ...item, prefixAgent: prefix.agent });
    }

    const agentPrs = [...recentAgentPulls.values()];
    for (const item of agentPrs) {
      const agent = agentFromPull(item) || item.prefixAgent;
      recentPrs.push({
        repository: fullName,
        number: item.number,
        title: item.title,
        url: item.html_url,
        state: item.state,
        createdAt: item.created_at,
        mergedAt: item.pull_request?.merged_at || null,
        agent,
      });
      const [targetOwner, targetRepo] = fullName.split('/');
      const comments = await github.paginate(github.rest.issues.listComments, {
        owner: targetOwner,
        repo: targetRepo,
        issue_number: item.number,
        per_page: 100,
      });
      for (const comment of comments) {
        const invocation = parseInvocationComment(comment.body);
        if (!invocation || invocationRuns.has(invocation.runId)) continue;
        let conclusion = 'unknown';
        try {
          const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo: autoDevRepo, run_id: invocation.runId });
          conclusion = run.conclusion || run.status || 'unknown';
        } catch (error) {
          core.warning(`Could not read AutoDev run ${invocation.runId}: ${error.message}`);
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
    recentPrs: recentPrs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 10),
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
