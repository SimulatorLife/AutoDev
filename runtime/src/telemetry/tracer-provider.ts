/*
  The one way an AutoDev process installs the OpenTelemetry tracing SDK.

  OpenTelemetry JS SDK 3 folded `sdk-trace-base` and `sdk-trace-node` into
  `@opentelemetry/sdk-trace` and dropped `NodeTracerProvider.register()`. That
  call used to install three globals at once: the tracer provider, an
  AsyncLocalStorage context manager (so the active span survives `await`), and
  the W3C trace-context + baggage propagator (so `propagation.inject/extract`
  carry `traceparent`). Registering only the provider would leave spans
  unparented across async boundaries and propagation silently empty, so every
  process that traces registers all three here.
*/
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator
} from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  TracerProvider
} from "@opentelemetry/sdk-trace";

export function buildOtlpSpanProcessors(options: {
  readonly endpoint: string | null | undefined;
  readonly headers: Record<string, string> | undefined;
  readonly testExporter: SpanExporter | null;
  readonly onExporterError: () => void;
}): {
  readonly processors: SpanProcessor[];
  readonly hasOtlpExporter: boolean;
} {
  const processors: SpanProcessor[] = [];
  let hasOtlpExporter = false;
  if (options.endpoint) {
    try {
      processors.push(
        new BatchSpanProcessor({
          exporter: new OTLPTraceExporter({
            url: options.endpoint,
            ...(options.headers !== undefined && { headers: options.headers })
          })
        })
      );
      hasOtlpExporter = true;
    } catch {
      options.onExporterError();
    }
  }
  if (options.testExporter) {
    processors.push(
      new SimpleSpanProcessor({ exporter: options.testExporter })
    );
  }
  return { processors, hasOtlpExporter };
}

export function registerTracerProvider(options: {
  readonly resource: Resource;
  readonly spanProcessors: SpanProcessor[];
}): TracerProvider {
  const provider = new TracerProvider({
    resource: options.resource,
    spanProcessors: options.spanProcessors
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(contextManager)) {
    contextManager.disable();
  }
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()]
    })
  );
  trace.setGlobalTracerProvider(provider);
  return provider;
}
