import assert from "node:assert/strict";
import test from "node:test";

import { classifyProviderFailure } from "@simulatorlife/autodev-runtime/router/events";
import { decideCandidateFailure } from "@simulatorlife/autodev-runtime/router/proxy";
import {
  PROVIDER_REQUEST_UNSUPPORTED_TYPE,
  providerRequestUnsupported,
  requestCarriesImageContent
} from "@simulatorlife/autodev-runtime/shared/provider-http";

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
