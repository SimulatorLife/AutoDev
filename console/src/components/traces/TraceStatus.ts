import type { UsageTraceStatus } from "@simulatorlife/autodev-core";
import React from "react";

export function TraceStatus({
  statusCode
}: {
  readonly statusCode: UsageTraceStatus;
}): React.JSX.Element {
  const className =
    statusCode === "ERROR"
      ? "text-error"
      : statusCode === "OK"
        ? "text-success"
        : "text-fg-secondary";
  return React.createElement(
    "span",
    {
      className: `font-mono text-xs ${className}`,
      "data-trace-status": statusCode
    },
    statusCode === "UNSET" ? "Unset" : statusCode
  );
}
