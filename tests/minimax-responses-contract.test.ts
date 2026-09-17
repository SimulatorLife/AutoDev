import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  coerceResponseBody,
  freeformInputFromArguments,
  isWebResearchTool,
  rewriteOutboundPayload,
} from '../src/providers/minimax.ts';

type JsonObject = Record<string, any>;
type ContractCase = { request: JsonObject; upstreamResponse: JsonObject; expected: JsonObject };
type Contract = { schema: string; cases: Record<string, ContractCase> };

const contract = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/contracts/minimax-responses-contract.json', import.meta.url)), 'utf8')) as Contract;

assert.equal(contract.schema, 'autodev-minimax-responses-contract-v2', 'MiniMax boundary contract must match its schema tag');

function caseFor(name: string): ContractCase {
  const value = contract.cases[name];
  if (!value) throw new Error(`MiniMax contract case is missing: ${name}`);
  return value;
}

describe('MiniMax boundary contract', () => {
  describe('namespace_tools_forwarded', () => {
    const entry = caseFor('namespace_tools_forwarded');

    test('request tools reach MiniMax exactly as Codex (or the router) sent them', () => {
      assert.deepEqual(rewriteOutboundPayload(entry.request)?.tools, entry.request.tools);
    });

    test("MiniMax's native namespace on a tool call is part of the contract the adapter relies on", () => {
      assert.deepEqual(
        entry.upstreamResponse.output.filter((item: JsonObject) => item.type === 'function_call').map((item: JsonObject) => item.namespace),
        entry.expected.responseOutputNamespaces,
      );
    });

    test('isWebResearchTool keeps Codex-native web research tools out of freeform coercion', () => {
      for (const tool of [{ type: 'web_search' }, { name: 'web_fetch' }]) {
        assert.equal(isWebResearchTool(tool), true);
      }
      assert.equal(isWebResearchTool({ type: 'function', name: 'read_file' }), false);
    });
  });

  describe('client_metadata_dropped', () => {
    const entry = caseFor('client_metadata_dropped');

    test('body-embedded Codex turn metadata never leaves the machine', () => {
      const forwarded = rewriteOutboundPayload(entry.request);
      assert.ok(forwarded && typeof forwarded === 'object');
      assert.deepEqual(Object.keys(forwarded).sort(), entry.expected.forwardedKeys);
      assert.equal(JSON.stringify(forwarded).includes('private-repo'), false);
    });
  });

  describe('freeform_coercion_non_streaming', () => {
    const entry = caseFor('freeform_coercion_non_streaming');
    const freeformNames = new Set(['exec']);

    test('coerceResponseBody rewrites a freeform function_call into a custom_tool_call', () => {
      const coerced = coerceResponseBody(entry.upstreamResponse, freeformNames);
      assert.ok(coerced && typeof coerced === 'object');
      const response = coerced.response as JsonObject;
      const rewritten = (response.output as JsonObject[])[0]!;
      assert.equal(rewritten.type, entry.expected.coercedType);
      assert.match(String(rewritten.input), new RegExp(String(entry.expected.inputSource.startsWith).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(String(rewritten.input), new RegExp(String(entry.expected.inputSource.mentions).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    test('freeformInputFromArguments unwraps an exec_command-shaped payload directly', () => {
      const source = freeformInputFromArguments('{"cmd":"wc -l README.md"}');
      assert.match(source ?? '', /await tools\.exec_command\(/);
      assert.match(source ?? '', /wc -l README\.md/);
    });

    test('freeformInputFromArguments returns a raw script unchanged', () => {
      const source = freeformInputFromArguments("node -e 'console.log(1)'");
      assert.equal(source, "node -e 'console.log(1)'");
    });
  });

  describe('freeform_unrecognised_feedback', () => {
    const entry = caseFor('freeform_unrecognised_feedback');

    test('an unrecognisable freeform call becomes an explanatory failing script that never echoes argument values', () => {
      const coerced = coerceResponseBody(entry.upstreamResponse, new Set(['exec']));
      assert.ok(coerced && typeof coerced === 'object');
      const rewritten = (coerced.output as JsonObject[])[0]!;
      assert.equal(rewritten.type, entry.expected.coercedType);
      const input = String(rewritten.input);
      assert.ok(input.startsWith(String(entry.expected.inputSource.startsWith)));
      const message = JSON.parse(input.slice(String(entry.expected.inputSource.startsWith).length, input.lastIndexOf(')')));
      assert.ok(message.includes(entry.expected.inputSource.mentions));
      assert.equal(input.includes(entry.expected.neverContains), false);
    });
  });

  describe('web_search_preserved', () => {
    const entry = caseFor('web_search_preserved');

    test("MiniMax's documented Responses web_search server tool is forwarded unchanged", () => {
      assert.deepEqual(rewriteOutboundPayload(entry.request)?.tools, entry.request.tools);
    });
  });
});
