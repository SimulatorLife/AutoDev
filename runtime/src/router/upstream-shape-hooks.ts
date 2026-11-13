import { recordRouterEvent } from "@simulatorlife/autodev-runtime/router/events";
import {
  dropUnresolvableReasoning,
  normalizeInputItemIds
} from "@simulatorlife/autodev-runtime/shared/responses-item-ids";

import { setUpstreamShapeHooks } from "./responses.ts";

/**
 * Give the upstream request shaper the shared item-id repairs and a way to
 * report what it changed as router events.
 */
export function installUpstreamShapeHooks(): void {
  setUpstreamShapeHooks({
    dropUnresolvableReasoning: (input) => {
      const result = dropUnresolvableReasoning(input);
      return { input: result.input, dropped: result.dropped };
    },
    normalizeInputItemIds: (input) => {
      const result = normalizeInputItemIds(input);
      return { input: result.input, changed: result.changed };
    },
    shouldNormalizeItemIds: true,
    shouldDropUnresolvableReasoning: true,
    recordEvent: (event) => {
      if (typeof event.requestId !== "string" || event.requestId.length === 0)
        return;
      recordRouterEvent({
        phase: String(event.phase ?? "router_transform"),
        requestId: event.requestId,
        requestedModel:
          typeof event.requestedModel === "string"
            ? event.requestedModel
            : null,
        provider: typeof event.provider === "string" ? event.provider : null,
        model: typeof event.model === "string" ? event.model : null,
        droppedReasoningItems:
          typeof event.droppedReasoningItems === "number"
            ? event.droppedReasoningItems
            : 0,
        normalizedItemIds:
          typeof event.normalizedItemIds === "number"
            ? event.normalizedItemIds
            : 0
      });
    }
  });
}
