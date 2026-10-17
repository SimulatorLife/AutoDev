"use client";

import {
  assertWorkspaceVisualPlaytestTargetApproval,
  type ControlApiWorkspaceVisualPlaytestTargetsResponse,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import React, { useEffect, useState } from "react";

import { Button } from "../../components/forms/Button.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import {
  DETAIL_PANEL_CLASS,
  NESTED_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import {
  MONO_META_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { responseMessage } from "../playtesting/playtesting-run-messages.ts";
import {
  workspacePath,
  workspaceVisualPlaytestTargetRevocationPath,
  workspaceVisualPlaytestTargetsPath
} from "./paths.ts";

export interface WorkspaceVisualTargetUnavailable {
  readonly code: string;
  readonly message: string;
}

const DEFAULT_LIMITS = {
  episodeCount: 1,
  maxStepsPerEpisode: 80,
  wallTimeMs: 120_000,
  smartRequestsPerEpisode: 30,
  smartTokensPerEpisode: 25_000,
  screenshotCountPerEpisode: 160,
  artifactBytesPerEpisode: 64 * 1024 * 1024
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workspaceTargetsFromResponse(
  value: unknown,
  workspaceId: string
): ControlApiWorkspaceVisualPlaytestTargetsResponse | null {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-workspace-visual-playtest-targets-v1" ||
    value.workspaceId !== workspaceId ||
    typeof value.workspaceEnabled !== "boolean" ||
    !Array.isArray(value.targets)
  ) {
    return null;
  }
  try {
    for (const target of value.targets) {
      assertWorkspaceVisualPlaytestTargetApproval(target);
      if (target.workspaceId !== workspaceId) return null;
    }
  } catch {
    return null;
  }
  return value as unknown as ControlApiWorkspaceVisualPlaytestTargetsResponse;
}

function targetsFromMutationResponse(
  payload: unknown,
  workspaceId: string
): ControlApiWorkspaceVisualPlaytestTargetsResponse | null {
  if (!isRecord(payload)) return null;
  if (payload.kind === "ok") {
    return workspaceTargetsFromResponse(payload.data, workspaceId);
  }
  if (isRecord(payload.currentTargets)) {
    return workspaceTargetsFromResponse(payload.currentTargets, workspaceId);
  }
  return null;
}

function targetIdFromName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 96);
  return normalized || "visual-target";
}

function textField(
  label: string,
  name: string,
  options: {
    readonly defaultValue?: string;
    readonly required?: boolean;
    readonly placeholder?: string;
    readonly type?: "text" | "url" | "number";
    readonly min?: number;
    readonly max?: number;
    readonly className?: string;
  } = {}
): React.JSX.Element {
  return React.createElement(
    "label",
    {
      className: `flex min-w-0 flex-col gap-1 ${MUTED_META_CLASS} ${options.className ?? ""}`,
      key: name
    },
    label,
    React.createElement("input", {
      className: FIELD_CONTROL_CLASS,
      defaultValue: options.defaultValue,
      name,
      required: options.required ?? false,
      placeholder: options.placeholder,
      type: options.type ?? "text",
      min: options.min,
      max: options.max,
      maxLength: options.type === "number" ? undefined : 2048,
      autoComplete: "off"
    })
  );
}

function targetCard(
  target: WorkspaceVisualPlaytestTargetApproval,
  onRevoke: (
    target: WorkspaceVisualPlaytestTargetApproval,
    reason: string
  ) => void,
  pendingTargetId: string | null
): React.JSX.Element {
  const active = target.revokedAt === null;
  return React.createElement(
    "li",
    {
      key: target.targetId,
      className: NESTED_PANEL_CLASS,
      "data-visual-target": target.targetId,
      "data-approval-state": active ? "active" : "revoked"
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-start justify-between gap-3" },
      React.createElement(
        "div",
        { className: "min-w-0 flex-1" },
        React.createElement("p", { className: "font-medium" }, target.name),
        React.createElement(
          "p",
          { className: `mt-1 break-all ${MONO_META_CLASS}` },
          target.targetId
        ),
        React.createElement(
          "p",
          { className: `mt-2 break-all ${MUTED_BODY_CLASS}` },
          target.entryUrl
        )
      ),
      React.createElement(StatusBadge, {
        status: active ? "ready" : "unavailable",
        label: active ? "Approved" : "Revoked"
      })
    ),
    React.createElement(
      DetailGrid,
      { columns: 2, className: "mt-3" },
      React.createElement(
        DetailValue,
        {
          label: "Allowed origins",
          valueClassName: `${MUTED_BODY_CLASS} break-all`
        },
        target.allowedOrigins.join(", ")
      ),
      React.createElement(
        DetailValue,
        { label: "Inputs / timing", valueClassName: MUTED_BODY_CLASS },
        `${target.inputCapabilities.join(", ")} · ${target.controlTimingClass}`
      ),
      React.createElement(
        DetailValue,
        { label: "Entry requirement", valueClassName: MUTED_BODY_CLASS },
        target.entryRequirements
      ),
      React.createElement(
        DetailValue,
        { label: "Budget", valueClassName: MUTED_BODY_CLASS },
        `${target.limits.episodeCount} episode · ${target.limits.maxStepsPerEpisode} steps · ${Math.round(target.limits.wallTimeMs / 1000)}s · ${target.limits.screenshotCountPerEpisode} frames`
      ),
      React.createElement(
        DetailValue,
        {
          label: "Approved",
          valueClassName: MUTED_BODY_CLASS,
          rowClassName: "sm:col-span-2"
        },
        `${target.approvedAt} by ${target.approvedBy}`
      ),
      active
        ? React.createElement(
            "div",
            { className: "sm:col-span-2" },
            React.createElement(
              "details",
              {
                className: "rounded-md border border-error/50 p-3",
                "data-visual-target-revoke": target.targetId
              },
              React.createElement(
                "summary",
                {
                  className: `cursor-pointer ${MUTED_BODY_CLASS} font-medium text-error`
                },
                "Revoke target"
              ),
              React.createElement(
                "form",
                {
                  className: "mt-3 flex flex-wrap items-end gap-3",
                  onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const reason = String(form.get("reason") ?? "").trim();
                    if (reason.length > 0) onRevoke(target, reason);
                  }
                },
                React.createElement(
                  "label",
                  {
                    className: `flex min-w-64 flex-1 flex-col gap-1 ${MUTED_META_CLASS}`
                  },
                  "Reason",
                  React.createElement("input", {
                    className: FIELD_CONTROL_CLASS,
                    name: "reason",
                    maxLength: 1024,
                    required: true,
                    autoComplete: "off"
                  })
                ),
                React.createElement(
                  Button,
                  {
                    type: "submit",
                    variant: "destructive",
                    disabled: pendingTargetId !== null
                  },
                  pendingTargetId === target.targetId
                    ? "Revoking…"
                    : "Confirm revocation"
                )
              )
            )
          )
        : React.createElement(
            "div",
            { className: "sm:col-span-2" },
            React.createElement(
              "p",
              { className: MUTED_META_CLASS },
              `Revoked ${target.revokedAt} by ${target.revokedBy}: ${target.revocationReason}`
            )
          )
    )
  );
}

export function WorkspaceVisualPlaytestTargetManager({
  workspaceId,
  workspaceEnabled,
  initialTargets,
  unavailable
}: {
  readonly workspaceId: string;
  readonly workspaceEnabled: boolean;
  readonly initialTargets:
    readonly WorkspaceVisualPlaytestTargetApproval[] | null;
  readonly unavailable?: WorkspaceVisualTargetUnavailable | undefined;
}): React.JSX.Element {
  const [targets, setTargets] = useState(initialTargets);
  const [pending, setPending] = useState(false);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [name, setName] = useState("");
  const targetId = targetIdFromName(name);
  const currentTarget =
    targets?.find((target) => target.targetId === targetId) ?? null;
  const canApproveTarget =
    currentTarget === null || currentTarget.revokedAt !== null;
  const expectedRevision =
    currentTarget === null ? "" : String(currentTarget.revision);

  useEffect(() => setTargets(initialTargets), [initialTargets]);

  async function submitTarget(
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault();
    if (!workspaceEnabled || targets === null || !canApproveTarget) return;
    setFailure(null);
    setAnnouncement("");
    const form = new FormData(event.currentTarget);
    if (form.getAll("inputCapabilities").length === 0) {
      setFailure("Select at least one approved input capability.");
      return;
    }
    setPending(true);
    const body = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") body.append(key, value);
    }
    try {
      const response = await fetch(
        workspaceVisualPlaytestTargetsPath(workspaceId),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded"
          },
          body
        }
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const current = targetsFromMutationResponse(payload, workspaceId);
        if (current) setTargets(current.targets);
        setFailure(responseMessage(payload));
        return;
      }
      const saved = targetsFromMutationResponse(payload, workspaceId);
      if (!saved) {
        setFailure(
          "Runtime returned an incompatible visual target approval response."
        );
        return;
      }
      setTargets(saved.targets);
      setAnnouncement(
        `Visual target ${targetId} approval was saved. Runtime still checks driver availability and target permissions before any play begins.`
      );
      setName("");
    } catch {
      setFailure(
        "The same-origin visual target request could not reach Runtime."
      );
    } finally {
      setPending(false);
    }
  }

  async function revokeTarget(
    target: WorkspaceVisualPlaytestTargetApproval,
    reason: string
  ): Promise<void> {
    if (!workspaceEnabled || pendingTargetId !== null) return;
    setPendingTargetId(target.targetId);
    setFailure(null);
    setAnnouncement("");
    const body = new URLSearchParams({
      workspaceId,
      targetId: target.targetId,
      approvalId: target.approvalId,
      expectedRevision: String(target.revision),
      reason,
      returnTo: workspacePath(workspaceId)
    });
    try {
      const response = await fetch(
        workspaceVisualPlaytestTargetRevocationPath(
          workspaceId,
          target.targetId
        ),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded"
          },
          body
        }
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const current = targetsFromMutationResponse(payload, workspaceId);
        if (current) setTargets(current.targets);
        setFailure(responseMessage(payload));
        return;
      }
      const saved = targetsFromMutationResponse(payload, workspaceId);
      if (!saved) {
        setFailure(
          "Runtime returned an incompatible visual target revocation response."
        );
        return;
      }
      setTargets(saved.targets);
      setAnnouncement(`Visual target ${target.targetId} was revoked.`);
    } catch {
      setFailure(
        "The same-origin visual target revocation could not reach Runtime."
      );
    } finally {
      setPendingTargetId(null);
    }
  }

  return React.createElement(
    "section",
    {
      className: DETAIL_PANEL_CLASS,
      "aria-labelledby": "workspace-visual-targets-heading",
      "data-section": "workspace-visual-targets"
    },
    React.createElement(
      "h2",
      {
        id: "workspace-visual-targets-heading",
        className: SECTION_HEADING_CLASS
      },
      "Autonomous visual targets"
    ),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "This approval is separate from the adapter checkout approval. It pins a browser entry URL, exact origins, permitted inputs, and per-episode budgets; it never grants shell or repository access and does not require re-approval for each game commit."
    ),
    React.createElement(
      "p",
      { className: `${MUTED_META_CLASS} mt-2` },
      "Approval records permission; it does not mean Play can run yet. This Runtime has no visual browser driver. P1 also refuses targets requiring consent/account setup or continuous timing. Local apps need an isolated browser profile and exact loopback origin."
    ),
    unavailable
      ? React.createElement(
          "div",
          {
            className:
              "mt-3 rounded-lg border border-warning/40 bg-surface-raised p-4",
            role: "status",
            "data-visual-targets-unavailable": unavailable.code
          },
          React.createElement(
            "p",
            { className: "font-medium" },
            "Visual target approvals are unavailable"
          ),
          React.createElement(
            "p",
            { className: `${MUTED_META_CLASS} mt-1` },
            unavailable.message
          )
        )
      : targets === null
        ? React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            "No visual target list was returned."
          )
        : targets.length === 0
          ? React.createElement(
              "p",
              { className: `${MUTED_META_CLASS} mt-3` },
              "No visual browser targets have been approved for this workspace."
            )
          : React.createElement(
              "ul",
              {
                className: "mt-3 grid gap-3",
                "aria-label": "Approved visual targets"
              },
              ...targets.map((target) =>
                targetCard(
                  target,
                  (item, reason) => void revokeTarget(item, reason),
                  pendingTargetId
                )
              )
            ),
    React.createElement(
      "details",
      {
        className: "mt-4 rounded-lg border border-border bg-surface",
        open: targets?.length === 0
      },
      React.createElement(
        "summary",
        {
          className: `cursor-pointer px-4 py-3 ${MUTED_BODY_CLASS} font-medium`
        },
        "Add a visual target"
      ),
      React.createElement(
        "form",
        {
          className: "grid gap-4 border-t border-border p-4",
          onSubmit: (event: React.FormEvent<HTMLFormElement>) =>
            void submitTarget(event),
          "aria-label": "Approve visual browser target",
          "data-visual-target-approval-form": workspaceId
        },
        React.createElement("input", {
          type: "hidden",
          name: "workspaceId",
          value: workspaceId
        }),
        React.createElement("input", {
          type: "hidden",
          name: "returnTo",
          value: workspacePath(workspaceId)
        }),
        React.createElement("input", {
          type: "hidden",
          name: "expectedRevision",
          value: expectedRevision
        }),
        React.createElement("input", {
          type: "hidden",
          name: "targetId",
          value: targetId
        }),
        React.createElement(
          "div",
          { className: "grid gap-3 md:grid-cols-2" },
          React.createElement(
            "label",
            { className: `flex flex-col gap-1 ${MUTED_META_CLASS}` },
            "Target name",
            React.createElement("input", {
              className: FIELD_CONTROL_CLASS,
              required: true,
              maxLength: 160,
              name: "name",
              value: name,
              onChange: (event) => setName(event.currentTarget.value),
              autoComplete: "off"
            }),
            React.createElement(
              "span",
              { className: MUTED_META_CLASS },
              `Target id: ${targetId}`
            )
          ),
          textField("Already-running game URL", "entryUrl", {
            required: true,
            placeholder: "https://game.example/"
          })
        ),
        textField(
          "Additional exact browser origins (comma-separated)",
          "additionalOrigins",
          {
            placeholder: "https://assets.example"
          }
        ),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          "The entry origin is added automatically. Remote origins must use HTTPS; HTTP is accepted only for loopback. Query strings, fragments, credentials, wildcards, and cross-origin navigation are refused."
        ),
        React.createElement(
          "div",
          { className: "grid gap-3 md:grid-cols-3" },
          React.createElement(
            "fieldset",
            { className: "flex flex-col gap-2" },
            React.createElement(
              "legend",
              { className: MUTED_META_CLASS },
              "Allowed inputs"
            ),
            ...(
              [
                ["keyboard", "Keyboard"],
                ["pointer", "Mouse / pointer"],
                ["gamepad", "Gamepad"]
              ] as const
            ).map(([value, label]) =>
              React.createElement(
                "label",
                {
                  key: value,
                  className: `flex min-h-8 items-center gap-2 ${MUTED_BODY_CLASS}`
                },
                React.createElement("input", {
                  type: "checkbox",
                  name: "inputCapabilities",
                  value,
                  defaultChecked: value !== "gamepad"
                }),
                label
              )
            )
          ),
          React.createElement(
            "label",
            { className: `flex flex-col gap-1 ${MUTED_META_CLASS}` },
            "Control timing",
            React.createElement(
              "select",
              {
                className: FIELD_CONTROL_CLASS,
                name: "controlTimingClass",
                defaultValue: "turn-based"
              },
              ...(["turn-based", "pausable", "continuous"] as const).map(
                (value) =>
                  React.createElement("option", { key: value, value }, value)
              )
            )
          ),
          React.createElement(
            "label",
            { className: `flex flex-col gap-1 ${MUTED_META_CLASS}` },
            "Entry requirement",
            React.createElement(
              "select",
              {
                className: FIELD_CONTROL_CLASS,
                name: "entryRequirements",
                defaultValue: "none"
              },
              ...(
                [
                  "none",
                  "consent-or-age-screen",
                  "local-account",
                  "credentialed"
                ] as const
              ).map((value) =>
                React.createElement("option", { key: value, value }, value)
              )
            )
          )
        ),
        React.createElement(
          "details",
          { className: "rounded-lg border border-border p-3" },
          React.createElement(
            "summary",
            {
              className: `cursor-pointer ${MUTED_BODY_CLASS} font-medium`
            },
            "Per-episode budgets"
          ),
          React.createElement(
            "div",
            { className: "mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" },
            ...[
              [
                "Episode count",
                "episodeCount",
                DEFAULT_LIMITS.episodeCount,
                1,
                1000
              ],
              [
                "Decision steps",
                "maxStepsPerEpisode",
                DEFAULT_LIMITS.maxStepsPerEpisode,
                1,
                10_000
              ],
              [
                "Wall time (ms)",
                "wallTimeMs",
                DEFAULT_LIMITS.wallTimeMs,
                1000,
                3_600_000
              ],
              [
                "Smart requests",
                "smartRequestsPerEpisode",
                DEFAULT_LIMITS.smartRequestsPerEpisode,
                0,
                1000
              ],
              [
                "Smart tokens",
                "smartTokensPerEpisode",
                DEFAULT_LIMITS.smartTokensPerEpisode,
                0,
                1_000_000
              ],
              [
                "Screenshot count",
                "screenshotCountPerEpisode",
                DEFAULT_LIMITS.screenshotCountPerEpisode,
                1,
                2000
              ],
              [
                "Artifact bytes",
                "artifactBytesPerEpisode",
                DEFAULT_LIMITS.artifactBytesPerEpisode,
                1024,
                1_073_741_824
              ]
            ].map(([label, field, value, min, max]) =>
              textField(String(label), String(field), {
                defaultValue: String(value),
                required: true,
                type: "number",
                min: Number(min),
                max: Number(max)
              })
            )
          )
        ),
        failure
          ? React.createElement(
              "p",
              { className: `${MUTED_BODY_CLASS} text-error`, role: "alert" },
              failure
            )
          : null,
        announcement
          ? React.createElement(
              "p",
              { className: `${MUTED_BODY_CLASS} text-success`, role: "status" },
              announcement
            )
          : null,
        currentTarget?.revokedAt === null
          ? React.createElement(
              "p",
              { className: MUTED_META_CLASS, role: "status" },
              "This target id is already active. Revoke it before approving a replacement, or choose another name."
            )
          : null,
        workspaceEnabled
          ? null
          : React.createElement(
              "p",
              { className: MUTED_META_CLASS, role: "status" },
              "This workspace is disabled. Target approvals are read-only until it is re-enabled."
            ),
        React.createElement(
          Button,
          {
            className: "min-h-11 justify-self-start",
            disabled:
              pending ||
              targets === null ||
              !workspaceEnabled ||
              !canApproveTarget ||
              targetId === "visual-target",
            type: "submit",
            variant: "primary"
          },
          pending ? "Approving visual target…" : "Approve visual target"
        )
      )
    ),
    React.createElement(
      "p",
      { className: `${MUTED_META_CLASS} mt-3` },
      "An approval records authority only. The Play dialog still requires Runtime preflight to confirm the isolated browser driver and policy are ready before it can start."
    )
  );
}
