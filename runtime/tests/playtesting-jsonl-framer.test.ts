import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonLineFrameError,
  JsonLineFramer
} from "../src/playtesting/jsonl-framer.ts";

test("JsonLineFramer joins partial UTF-8 chunks before line decoding", () => {
  const framer = new JsonLineFramer(32);
  const message = Buffer.from('{"value":"play🎮"}\n', "utf8");
  const split = message.indexOf(0xf0) + 2;
  assert.deepEqual(framer.push(message.subarray(0, split)), []);
  const [line] = framer.push(message.subarray(split));
  assert.equal(line?.toString("utf8"), '{"value":"play🎮"}');
  assert.equal(framer.pendingBytes, 0);
});

test("JsonLineFramer emits multiple complete messages from one chunk", () => {
  const framer = new JsonLineFramer(32);
  const lines = framer.push(Buffer.from('{"id":"1"}\n{"id":"2"}\n'));
  assert.deepEqual(
    lines.map((line) => line.toString("utf8")),
    ['{"id":"1"}', '{"id":"2"}']
  );
  assert.equal(framer.pendingBytes, 0);
});

test("JsonLineFramer accepts the exact limit and rejects the next byte", () => {
  const framer = new JsonLineFramer(4);
  assert.deepEqual(framer.push(Buffer.from("1234\n"))[0]?.toString(), "1234");
  assert.throws(() => framer.push(Buffer.from("12345")), JsonLineFrameError);
  assert.equal(framer.pendingBytes, 0);
});

test("JsonLineFramer keeps bounded partial bytes available for failure evidence", () => {
  const framer = new JsonLineFramer(8);
  framer.push(Buffer.from("partial"));
  assert.equal(framer.pendingBytes, 7);
  assert.equal(framer.pendingLine().toString(), "partial");
  framer.clear();
  assert.equal(framer.pendingBytes, 0);
});
