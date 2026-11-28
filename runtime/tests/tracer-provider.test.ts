import assert from "node:assert/strict";
import test from "node:test";

import {
  context,
  diag,
  DiagLogLevel,
  propagation,
  trace
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type TracerProvider
} from "@opentelemetry/sdk-trace";
import {
  buildOtlpSpanProcessors,
  registerTracerProvider
} from "@simulatorlife/autodev-runtime/telemetry/tracer-provider";

function resetOtelGlobals(): void {
  trace.disable();
  context.disable();
  propagation.disable();
}

test("registerTracerProvider installs tracer, async context across await, and W3C propagation", async () => {
  const exporter = new InMemorySpanExporter();
  let provider: TracerProvider | null = null;
  resetOtelGlobals();
  try {
    provider = registerTracerProvider({
      resource: resourceFromAttributes({
        "service.name": "autodev-tracer-provider-test"
      }),
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    });
    const tracer = trace.getTracer("tracer-provider-test");
    const parent = tracer.startSpan("parent");
    await context.with(trace.setSpan(context.active(), parent), async () => {
      await Promise.resolve();
      const child = tracer.startSpan("child");
      const carrier: Record<string, string> = {};
      const activeWithBaggage = propagation.setBaggage(
        trace.setSpan(context.active(), child),
        propagation.createBaggage({
          "autodev.test": { value: "otel3" }
        })
      );
      propagation.inject(activeWithBaggage, carrier);
      child.end();

      assert.match(
        carrier.traceparent ?? "",
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u
      );
      assert.match(carrier.baggage ?? "", /autodev\.test=otel3/u);

      const extracted = propagation.extract(context.active(), carrier);
      const extractedContext = trace.getSpanContext(extracted);
      assert.equal(extractedContext?.traceId, parent.spanContext().traceId);
      assert.equal(extractedContext?.spanId, child.spanContext().spanId);
      assert.equal(
        propagation.getBaggage(extracted)?.getEntry("autodev.test")?.value,
        "otel3"
      );
    });
    parent.end();

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const finishedParent = spans.find((span) => span.name === "parent");
    const finishedChild = spans.find((span) => span.name === "child");
    assert.ok(finishedParent);
    assert.ok(finishedChild);
    assert.equal(
      finishedChild.parentSpanContext?.traceId,
      finishedParent.spanContext().traceId
    );
    assert.equal(
      finishedChild.parentSpanContext?.spanId,
      finishedParent.spanContext().spanId
    );
  } finally {
    resetOtelGlobals();
    if (provider) {
      await provider.shutdown();
    }
    await exporter.shutdown();
  }
});

test("registerTracerProvider re-registers cleanly after global teardown without duplicate errors", async () => {
  const diagErrors: string[] = [];
  diag.setLogger(
    {
      error: (message) => {
        diagErrors.push(message);
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
      verbose: () => {}
    },
    DiagLogLevel.ERROR
  );

  const firstExporter = new InMemorySpanExporter();
  const secondExporter = new InMemorySpanExporter();
  let firstProvider: TracerProvider | null = null;
  let secondProvider: TracerProvider | null = null;
  resetOtelGlobals();
  try {
    firstProvider = registerTracerProvider({
      resource: resourceFromAttributes({ "service.name": "first" }),
      spanProcessors: [new SimpleSpanProcessor({ exporter: firstExporter })]
    });
    resetOtelGlobals();
    await firstProvider.shutdown();
    firstProvider = null;

    secondProvider = registerTracerProvider({
      resource: resourceFromAttributes({ "service.name": "second" }),
      spanProcessors: [new SimpleSpanProcessor({ exporter: secondExporter })]
    });
    const span = trace.getTracer("re-register").startSpan("after-reset");
    span.end();
    await secondProvider.forceFlush();

    assert.deepEqual(diagErrors, []);
    assert.equal(firstExporter.getFinishedSpans().length, 0);
    assert.equal(secondExporter.getFinishedSpans().length, 1);
    assert.equal(secondExporter.getFinishedSpans()[0]?.name, "after-reset");
  } finally {
    diag.disable();
    resetOtelGlobals();
    if (firstProvider) {
      await firstProvider.shutdown();
    }
    if (secondProvider) {
      await secondProvider.shutdown();
    }
    await firstExporter.shutdown();
    await secondExporter.shutdown();
  }
});

test("buildOtlpSpanProcessors configures OTLP and test exporters cleanly", async () => {
  const testExporter = new InMemorySpanExporter();
  let errors = 0;

  const empty = buildOtlpSpanProcessors({
    endpoint: null,
    headers: undefined,
    testExporter: null,
    onExporterError: () => {
      errors += 1;
    }
  });
  assert.equal(empty.hasOtlpExporter, false);
  assert.equal(empty.processors.length, 0);

  const valid = buildOtlpSpanProcessors({
    endpoint: "http://127.0.0.1:4318/v1/traces",
    headers: { authorization: "Bearer token" },
    testExporter,
    onExporterError: () => {
      errors += 1;
    }
  });
  assert.equal(valid.hasOtlpExporter, true);
  assert.equal(valid.processors.length, 2);
  assert.equal(errors, 0);
  await Promise.all(valid.processors.map((processor) => processor.shutdown()));
  await testExporter.shutdown();
});
