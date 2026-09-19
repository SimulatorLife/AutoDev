import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTES, type ProviderRoute } from '../../src/router/routing.ts';
import '../../src/router/http.ts';
import { COOLDOWNS, type CooldownSummary } from '../../src/router/cooldown.ts';
import {
  CONCRETE_STATUS_MAX_ATTEMPTS,
  declaredLimit,
  downstreamHeaders,
  exhaustionBody,
  exhaustionHeaders,
  fallbackable,
  payloadForCandidate,
  proxyConcreteResponse,
  proxyFallbackChain,
  proxyOrchestratorResponse,
  proxyRoleResponse,
} from '../../src/router/proxy.ts';
import { TOOL_CALL_OWNERSHIP } from '../../src/router/tool-call-ownership.ts';
import { countLiveAgentActivity } from '../../src/router/usage.ts';
import { agentActivity, ingestAgentEvents } from '../../src/router/server.ts';
import { noteOrchestratorSession, resetSubagentTelemetry } from '../../src/router/subagents.ts';

function responseRecorder(): any {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    writeHead(status: number, headers: Record<string, string | number>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.body = Buffer.concat(chunks).toString('utf8');
      this.writableEnded = true;
    },
    on() { return this; },
    removeListener() { return this; },
  };
}

const route = (provider: string, envKey: string): ProviderRoute => ({
  provider,
  pattern: /.*/,
  baseUrl: `http://${provider}.test/v1`,
  envKey,
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('downstream headers and payload candidates preserve router-owned boundaries', () => {
  const previousKey = process.env.TEST_PROVIDER_KEY;
  process.env.TEST_PROVIDER_KEY = 'sk-test-provider';
  try {
  const claude = ROUTES.find((candidate) => candidate.provider === 'claude')!;
  const headers = downstreamHeaders({ ...claude, envKey: 'TEST_PROVIDER_KEY' }, null, '{"workspace":"safe"}', 'worker', 'req-1', { key: 'session-1', scope: 'identified' });
  assert.equal(headers.authorization, 'Bearer sk-test-provider');
  assert.equal(headers['x-codex-turn-metadata'], '{"workspace":"safe"}');
  assert.equal(headers['x-autodev-agent-role'], 'worker');
  assert.equal(headers['x-autodev-session-id'], 'session-1');
  assert.equal(headers['x-autodev-request-id'], 'req-1');

  assert.deepEqual(
    payloadForCandidate({ model: 'autodev/worker', reasoning: { effort: 'none' } }, { model: 'sonnet', reasoningEffort: 'high' }),
    { model: 'sonnet', reasoning: { effort: 'high' } },
  );
  } finally {
    if (previousKey === undefined) delete process.env.TEST_PROVIDER_KEY;
    else process.env.TEST_PROVIDER_KEY = previousKey;
  }
});

test('declared limits, fallback classification, and exhaustion diagnostics remain structured', () => {
  const headers = new Headers({ 'x-autodev-limit-class': 'quota_exhausted', 'x-autodev-limit-resets-at': '2026-09-17T00:00:00.000Z', 'x-autodev-limit-source': 'reported' });
  const limit = declaredLimit(headers, '');
  assert.deepEqual(limit, {
    limitClass: 'quota_exhausted',
    limitType: null,
    resetsAt: '2026-09-17T00:00:00.000Z',
    source: 'reported',
  });
  assert.equal(fallbackable(503, 'busy'), true);
  assert.equal(fallbackable(400, 'invalid model name'), true);

  const summary: CooldownSummary[] = [{ provider: 'claude', state: 'transient', failureClass: 'capacity', resetsAt: null, retryAfterMs: 2_000 }];
  const body = exhaustionBody({
    subject: 'worker turn',
    summary,
    failures: ['claude: HTTP 503'],
    model: 'sonnet',
    requestId: 'req-exhausted',
    lastResortAttempts: 1,
    deadlineReached: false,
  });
  assert.equal((body as any).error.code, 'router_provider_exhausted');
  assert.match((body as any).error.message, /worker turn/);
  assert.deepEqual(exhaustionHeaders({ summary, requestId: 'req-exhausted' }), {
    'x-autodev-request-id': 'req-exhausted',
    'retry-after': '2',
  });
});

test('concrete proxy retries one fallbackable status without rerouting', { concurrency: false }, async () => {
  COOLDOWNS.clearAll();
  const previousKey = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? new Response('temporarily unavailable', { status: 503 })
      : jsonResponse({ id: 'resp_1', status: 'completed', model: 'sonnet', output: [] });
  }) as typeof fetch;
  try {
    const response = responseRecorder();
    await proxyConcreteResponse(
      response,
      route('claude', 'LITELLM_API_KEY'),
      { model: 'sonnet', input: [], stream: false },
      false,
      'req-retry',
      null,
      null,
      null,
      { key: 'session-retry', scope: 'identified' },
    );
    assert.equal(calls, CONCRETE_STATUS_MAX_ATTEMPTS);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"status":"completed"/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previousKey;
    COOLDOWNS.clearAll();
  }
});

test('fallback chain tries candidates in declared order and stops after success', { concurrency: false }, async () => {
  COOLDOWNS.clearAll();
  const previousClaude = process.env.LITELLM_API_KEY;
  const previousMiniMax = process.env.MINIMAX_API_KEY;
  process.env.LITELLM_API_KEY = 'claude-key';
  process.env.MINIMAX_API_KEY = 'minimax-key';
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return url.includes('claude.test')
      ? new Response('capacity', { status: 503 })
      : jsonResponse({ id: 'resp_2', status: 'completed', model: 'MiniMax-M3', output: [] });
  }) as typeof fetch;
  try {
    const response = responseRecorder();
    await proxyFallbackChain(
      response,
      {
        candidates: [
          { ...route('claude', 'LITELLM_API_KEY'), model: 'sonnet' },
          { ...route('minimax', 'MINIMAX_API_KEY'), model: 'MiniMax-M3' },
        ],
        role: 'worker',
        subject: 'worker turn',
        sessionKey: 'session-chain',
        session: { key: 'session-chain', scope: 'identified' },
      },
      { model: 'autodev/worker', input: [], stream: false },
      false,
      'req-chain',
      null,
      null,
    );
    assert.deepEqual(calls, [
      'http://claude.test/v1/responses',
      'http://minimax.test/v1/responses',
    ]);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /resp_2/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousClaude === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previousClaude;
    if (previousMiniMax === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = previousMiniMax;
    COOLDOWNS.clearAll();
  }
});

test('a tool result goes back to the provider that streamed the call', { concurrency: false }, async () => {
  COOLDOWNS.clearAll();
  TOOL_CALL_OWNERSHIP.clear();
  const originalFetch = globalThis.fetch;
  const saved = { LITELLM_API_KEY: process.env.LITELLM_API_KEY, MINIMAX_API_KEY: process.env.MINIMAX_API_KEY };
  process.env.LITELLM_API_KEY = 'claude-key';
  process.env.MINIMAX_API_KEY = 'minimax-key';
  const call = { type: 'custom_tool_call', id: 'ctc_owned', call_id: 'call_owned_1', name: 'exec', input: 'text(1)', status: 'completed' };
  const sse = [
    { type: 'response.created', response: { id: 'resp_call', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, input: '', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: { id: 'resp_call', status: 'completed', output: [ call ] } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  try {
    globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    await proxyFallbackChain(
      responseRecorder(),
      { candidates: [ { ...route('claude', 'LITELLM_API_KEY'), model: 'sonnet' } ], role: 'worker', subject: 'worker turn' },
      { model: 'autodev/worker', input: [], stream: true },
      true,
      'req-issue',
      null,
      null,
    );
    const answering = { model: 'autodev/worker', stream: false, input: [ call, { type: 'custom_tool_call_output', call_id: 'call_owned_1', output: 'ok' } ] };
    assert.equal(TOOL_CALL_OWNERSHIP.ownerFor(answering), 'claude');

    // The worker tier shuffles its providers per request, so one draw could
    // land on Claude by chance; every draw must.
    const firstTried: string[] = [];
    let current: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      current.push(String(input));
      return jsonResponse({ id: 'resp_next', status: 'completed', output: [] });
    }) as typeof fetch;
    for (let draw = 0; draw < 12; draw += 1) {
      current = [];
      await proxyRoleResponse(responseRecorder(), 'worker', answering, false, `req-answer-${draw}`, null, null);
      firstTried.push(current[0] ?? '');
    }
    for (const url of firstTried) assert.match(url, /127\.0\.0\.1:4000/, 'the Claude bridge, which issued the call, is tried first');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [ key, value ] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    TOOL_CALL_OWNERSHIP.clear();
    COOLDOWNS.clearAll();
  }
});

test('one subagent thread is one live agent, however many requests it makes', { concurrency: false }, async () => {
  // Observed 2026-09-18: an explorer that made 45 tool calls in two minutes
  // showed as dozens of live agents, because each request was its own
  // activity subject and each one ending in a tool call stayed live in
  // tool_wait until the TTL.
  COOLDOWNS.clearAll();
  agentActivity.reset();
  resetSubagentTelemetry();
  const originalFetch = globalThis.fetch;
  const saved = { LITELLM_API_KEY: process.env.LITELLM_API_KEY, MINIMAX_API_KEY: process.env.MINIMAX_API_KEY };
  process.env.LITELLM_API_KEY = 'claude-key';
  process.env.MINIMAX_API_KEY = 'minimax-key';
  let sequence = 0;
  globalThis.fetch = (async () => {
    sequence += 1;
    const call = { type: 'function_call', id: `fc_${sequence}`, call_id: `call_${sequence}`, name: 'wait', arguments: '{}', status: 'completed' };
    return jsonResponse({ id: `resp_${sequence}`, status: 'completed', output: [ call ] });
  }) as typeof fetch;
  try {
    noteOrchestratorSession('root-1', 'codex', { model: 'gpt-5.6-luna', workspace: null, requestId: 'req-root' });
    for (let turn = 0; turn < 5; turn += 1) {
      await proxyRoleResponse(responseRecorder(), 'explorer', { model: 'autodev/explorer', input: [], stream: false }, false, `req-child-${turn}`, null, null, null,
        { key: 'root-1', scope: 'identified', thread: 'child-1' });
    }
    assert.equal(countLiveAgentActivity({ role: 'explorer' }), 1);
    assert.equal(agentActivity.getState('thread:child-1'), 'tool_wait');
    // A second child of the same root is a second agent.
    await proxyRoleResponse(responseRecorder(), 'explorer', { model: 'autodev/explorer', input: [], stream: false }, false, 'req-child2-0', null, null, null,
      { key: 'root-1', scope: 'identified', thread: 'child-2' });
    assert.equal(countLiveAgentActivity({ role: 'explorer' }), 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [ key, value ] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    agentActivity.reset();
    resetSubagentTelemetry();
    COOLDOWNS.clearAll();
  }
});

test("a subagent's bridge events describe the subagent, never its orchestrator", { concurrency: false }, async () => {
  // Observed 2026-09-19 with a MiniMax-served explorer under a Codex-served
  // orchestrator: every event the explorer's bridge posted landed on the
  // shared session key -- the orchestrator's record -- so the dashboard showed
  // no orchestrator, two explorers, and agents flipping in and out of view.
  COOLDOWNS.clearAll();
  agentActivity.reset();
  resetSubagentTelemetry();
  const originalFetch = globalThis.fetch;
  const saved = { LITELLM_API_KEY: process.env.LITELLM_API_KEY, MINIMAX_API_KEY: process.env.MINIMAX_API_KEY };
  process.env.LITELLM_API_KEY = 'claude-key';
  process.env.MINIMAX_API_KEY = 'minimax-key';
  let sequence = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    sequence += 1;
    const call = { type: 'custom_tool_call', id: `ctc_${sequence}`, call_id: `call_${sequence}`, name: 'exec', input: 'wait', status: 'completed' };
    const completed = { id: `resp_${sequence}`, status: 'completed', output: [ call ] };
    // Codex answers in SSE even to a non-streaming caller; the bridges answer in JSON.
    if (String(input).startsWith('https://chatgpt.com/')) {
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return jsonResponse(completed);
  }) as typeof fetch;
  const root = { key: 'root-1', scope: 'identified', thread: 'root-1' };
  const child = { key: 'root-1', scope: 'identified', thread: 'child-1' };
  try {
    await proxyOrchestratorResponse(responseRecorder(), { model: 'autodev/orchestrator', input: [], stream: false }, false, 'req-root-1', null, null, null, root);
    await proxyRoleResponse(responseRecorder(), 'explorer', { model: 'autodev/explorer', input: [], stream: false }, false, 'req-child-1', null, null, null, child);
    // The child's bridge reports that its request settled, as every bridge does at the end of a response.
    ingestAgentEvents({ requestId: 'req-child-1', events: [ { type: 'activity', state: 'finished' }, { type: 'heartbeat' } ] });

    const orchestrator = agentActivity.getRecord('root-1');
    assert.equal(orchestrator?.role, 'orchestrator', 'the child must not overwrite the orchestrator');
    assert.notEqual(orchestrator?.provider, 'minimax', "the child's provider must not replace the orchestrator's");
    // It ended its request in a tool call (its wait on the child) and stays live; the
    // child's per-request report must not have finished it.
    assert.equal(orchestrator?.state, 'tool_wait');
    // The router settled the child's request with a tool call: it is waiting on
    // that tool, not finished, whatever its bridge said about the request.
    assert.equal(agentActivity.getState('thread:child-1'), 'tool_wait');
    assert.equal(countLiveAgentActivity({ role: 'explorer' }), 1);
    assert.equal(countLiveAgentActivity({ role: 'orchestrator' }), 1);

    // What a child's bridge alone can report -- its own in-CLI delegation --
    // lands on the child.
    ingestAgentEvents({ requestId: 'req-child-1', events: [ { type: 'activity', state: 'subagent_wait' } ] });
    assert.equal(agentActivity.getState('thread:child-1'), 'subagent_wait');
    assert.equal(agentActivity.getRecord('root-1')?.role, 'orchestrator');
    assert.equal(agentActivity.getState('root-1'), 'tool_wait');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [ key, value ] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    agentActivity.reset();
    resetSubagentTelemetry();
    COOLDOWNS.clearAll();
  }
});
