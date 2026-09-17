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
} from '../../src/router/proxy.ts';

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
  const claude = ROUTES.find((candidate) => candidate.provider === 'claude')!;
  const headers = downstreamHeaders(claude, null, '{"workspace":"safe"}', 'worker', 'req-1', { key: 'session-1', scope: 'identified' });
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['x-codex-turn-metadata'], '{"workspace":"safe"}');
  assert.equal(headers['x-autodev-agent-role'], 'worker');
  assert.equal(headers['x-autodev-session-id'], 'session-1');
  assert.equal(headers['x-autodev-request-id'], 'req-1');

  assert.deepEqual(
    payloadForCandidate({ model: 'autodev/worker', reasoning: { effort: 'none' } }, { model: 'sonnet', reasoningEffort: 'high' }),
    { model: 'sonnet', reasoning: { effort: 'high' } },
  );
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
