/**
 * Badge rendering for run-owner state, split from the plain wording so a Node
 * test can import the labels without pulling in JSX.
 */
import React from "react";

import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  runStateBadgeTone,
  runStateLabel
} from "./playtesting-run-messages.ts";

export function batchStatusBadge(status: string): React.JSX.Element {
  return React.createElement(StatusBadge, {
    status: runStateBadgeTone(status),
    label: runStateLabel(status)
  });
}
