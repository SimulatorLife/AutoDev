import assert from "node:assert/strict";
import test from "node:test";

import { classifyProviderFailure } from "@simulatorlife/autodev-runtime/router/events";
import {
  classifyReportedFailure,
  decideCandidateFailure,
  streamFailureClass
} from "@simulatorlife/autodev-runtime/router/proxy";
import {
  PROVIDER_REQUEST_UNSUPPORTED_TYPE,
  providerRequestUnsupported,
  providerToolChannelUnavailable
} from "@simulatorlife/autodev-runtime/shared/provider-http";
import { INCOMPLETE_REASON_CODEX_TOOLS_UNREACHABLE } from "@simulatorlife/autodev-runtime/shared/provider-limits";
import {
  requestCarriesImageContent,
  requestImages
} from "@simulatorlife/autodev-runtime/shared/request-content";

const REFUSAL_BODY = JSON.stringify({
  error: {
    type: PROVIDER_REQUEST_UNSUPPORTED_TYPE,
    message: "This bridge cannot carry image content."
  }
});

test("a request that carries a frame is recognised as one a bridge cannot serve", () => {
  assert.equal(
    requestCarriesImageContent([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "the frame below is the game" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,iVBORw0KGgo="
          }
        ]
      }
    ]),
    true,
    "an image in the conversation must be recognised"
  );
  assert.equal(
    requestCarriesImageContent([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "no frame here" }]
      }
    ]),
    false,
    "a text-only conversation is not a frame"
  );
  assert.equal(
    requestCarriesImageContent("a plain string prompt"),
    false,
    "a prompt that is not a conversation carries no frame"
  );
});

test("the request's image is read as bytes a bridge can hand to its model", () => {
  const images = requestImages([
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_image",
          image_url: "data:image/png;base64,iVBORw0KGgo="
        }
      ]
    }
  ]);
  assert.deepEqual(images, [
    { kind: "bytes", mediaType: "image/png", data: "iVBORw0KGgo=" }
  ]);
});

test("an image the request only names is reported as a reference, not as bytes", () => {
  const images = requestImages([
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "https://example.test/frame.png" }
      ]
    }
  ]);
  assert.deepEqual(images, [
    { kind: "reference", url: "https://example.test/frame.png" }
  ]);
});

test("a tool output that carries an image does not make the turn unservable", () => {
  // The bridges deliver a tool's image through their image-aware tool path.
  // Refusing the whole turn for it would take away a request the bridge can
  // in fact serve.
  assert.equal(
    requestCarriesImageContent([
      {
        type: "custom_tool_call_output",
        call_id: "call-1",
        output: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,iVBORw0KGgo="
          }
        ]
      }
    ]),
    false,
    "a tool output image travels the image-aware tool path"
  );
});

test("the typed refusal is read apart from any other provider error", () => {
  assert.equal(providerRequestUnsupported(REFUSAL_BODY), true);
  assert.equal(
    providerRequestUnsupported(
      JSON.stringify({
        error: { type: "invalid_request_error", message: "no" }
      })
    ),
    false,
    "another error type is not a refusal"
  );
  assert.equal(
    providerRequestUnsupported("not json at all"),
    false,
    "a body that is not the refusal is not a refusal"
  );
  assert.equal(providerRequestUnsupported(null), false);
});

test("a route that cannot serve the request is a fallback, not a broken provider", () => {
  const decision = decideCandidateFailure(400, REFUSAL_BODY);
  assert.equal(decision.outcome, "fallback");
  assert.equal(
    decision.coolDown,
    false,
    "the provider is healthy: it served every other request shape"
  );
  assert.equal(
    classifyProviderFailure(400, REFUSAL_BODY),
    "unsupported_request",
    "the failure class names the limit rather than a provider fault"
  );
});

test("a route whose tool channel did not carry the turn falls back and cools down", () => {
  const body = JSON.stringify({
    error: {
      type: "provider_tool_channel_unavailable",
      code: "provider_tool_channel_unavailable",
      message:
        "the chatgpt reply ended a leaf agent's turn without calling a tool"
    }
  });
  const decision = decideCandidateFailure(400, body);
  assert.equal(
    decision.outcome,
    "fallback",
    "another candidate can do the turn the route answered without doing"
  );
  assert.equal(
    decision.coolDown,
    true,
    "the provider is counted, so the next turn does not repeat the refusal"
  );
  assert.equal(classifyProviderFailure(400, body), "tool_channel_unavailable");
});

test("a provider failure still cools down and still moves the chain on", () => {
  const throttled = decideCandidateFailure(429, "rate limit exceeded");
  assert.equal(throttled.outcome, "fallback");
  assert.equal(throttled.coolDown, true);

  const rejected = decideCandidateFailure(
    400,
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "the request is malformed"
      }
    })
  );
  assert.equal(
    rejected.outcome,
    "terminal",
    "a request the provider rejects on its merits is the client's answer"
  );
  assert.equal(rejected.coolDown, false);
});

test("codex_tools_unreachable from Claude and Antigravity maps to tool_channel_unavailable", () => {
  const claudeError = {
    type: "upstream_error",
    code: INCOMPLETE_REASON_CODEX_TOOLS_UNREACHABLE,
    message:
      'Claude ran without its tools: the codex MCP server reported status "failed".'
  };
  const antigravityError = {
    type: INCOMPLETE_REASON_CODEX_TOOLS_UNREACHABLE,
    code: INCOMPLETE_REASON_CODEX_TOOLS_UNREACHABLE,
    message:
      "Antigravity ran without its tools: the codex MCP server never reached the turn."
  };

  for (const error of [claudeError, antigravityError]) {
    const body = JSON.stringify({ error });
    assert.equal(providerToolChannelUnavailable(body), true);
    assert.equal(classifyReportedFailure(error), "tool_channel_unavailable");
    for (const status of [400, 502]) {
      assert.equal(
        classifyProviderFailure(status, body),
        "tool_channel_unavailable"
      );
      assert.deepEqual(decideCandidateFailure(status, body), {
        outcome: "fallback",
        coolDown: true
      });
    }
  }
});

test("streamFailureClass classifies codex_tools_unreachable incomplete responses as tool_channel_unavailable", () => {
  assert.equal(
    streamFailureClass({
      limit: null,
      incompleteReason: INCOMPLETE_REASON_CODEX_TOOLS_UNREACHABLE,
      error: null
    }),
    "tool_channel_unavailable"
  );
  assert.equal(
    streamFailureClass({
      limit: null,
      incompleteReason: "provider_interrupted",
      error: null
    }),
    "unavailable"
  );
});
