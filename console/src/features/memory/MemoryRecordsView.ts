import type {
  ControlApiMemoryWhyResponse,
  EvidenceReference,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  MemoryValidity
} from "@simulatorlife/autodev-core";
import React from "react";

import { CodeBlock } from "../../components/code/CodeBlock.ts";
import {
  FilterBar,
  FilterSearchField
} from "../../components/filters/FilterBar.ts";
import { Button } from "../../components/forms/Button.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { TextField } from "../../components/forms/TextField.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { Pagination } from "../../components/navigation/Pagination.ts";
import { DetailDrawer } from "../../components/panels/DetailDrawer.ts";
import { gridRowClass } from "../../components/panels/DetailGrid.ts";
import {
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import { Chip } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  MONO_META_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import {
  memoryDetailHref,
  memoryExperienceHref,
  memoryFilterHref,
  memoryListHref,
  memoryListQuery,
  type MemoryListScope,
  memoryPageHref
} from "./memory-list-url.ts";

export interface MemoryRecordTransition {
  readonly fromStatus?: MemoryStatus;
  readonly toStatus: MemoryStatus;
  readonly actor: { readonly id: string; readonly authority: string };
  readonly reason?: string;
  readonly timestamp: string;
}

export interface MemoryRecordHistory {
  readonly schema: string;
  readonly memory: MemoryRecord;
  readonly transitions: readonly MemoryRecordTransition[];
}

/**
 * Whether a claim's validity window has closed, as the Runtime decides it.
 *
 * `isEligibleRecord` refuses a record when `validTo <= asOf`, and this is that
 * same comparison against the same kind of timestamp. Kept as one helper so the
 * panel and the Runtime cannot drift into disagreeing about which claims are
 * live — a Console that called a live claim expired would be its own version of
 * the bug this panel exists to fix.
 *
 * Only a present, parseable bound closes the window. An unparseable one is
 * treated as absent rather than as expired: the Runtime would not parse it
 * either, and refusing a claim the Runtime is willing to inject is the worse
 * error.
 */
function isValidityWindowClosed(
  validity: MemoryValidity,
  asOf: string
): boolean {
  const validTo = validity.validTo;
  if (validTo === undefined) return false;
  const until = Date.parse(validTo);
  if (!Number.isFinite(until)) return false;
  return validTo <= asOf;
}

/** The render instant, compared as the Runtime compares its own `asOf`. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The validity window, as one sentence, or nothing when there is no window.
 *
 * Only a bound that exists is spoken about. An absent one is the absence of a
 * decision -- not "valid forever", not "expired" -- and rendering a dash would
 * claim one of those. Each shape is its own string rather than an assembled
 * phrase, so a half-written window cannot read as a complete sentence.
 */
function validityWindowLabel(
  validity: MemoryValidity
): string | null {
  const from = validity.validFrom;
  const to = validity.validTo;
  if (from !== undefined && to !== undefined) {
    return `Valid ${new Date(from).toLocaleString()} to ${new Date(to).toLocaleString()}`;
  }
  if (from !== undefined) {
    return `Valid from ${new Date(from).toLocaleString()}`;
  }
  if (to !== undefined) {
    return `Valid until ${new Date(to).toLocaleString()}`;
  }
  return null;
}

/**
 * What is known about a claim's validity, and whether that means it is injected.
 *
 * Its own component because the window is not an extra detail here -- it is the
 * fact that decides whether the Runtime will hand this claim to an agent at all.
 * `isEligibleRecord` refuses a record whose `validTo` has passed, so a claim
 * reading "active" and "verified" can be one nothing will ever use, and an
 * operator inspecting this panel is asking precisely that question.
 */
function ValidityFacts({
  validity,
  renderedAt
}: {
  readonly validity: MemoryValidity;
  readonly renderedAt: string;
}): React.JSX.Element {
  // Computed once: the label is needed both to decide whether to render the row
  // and to fill it, and formatting one window twice can produce two strings.
  const window = validityWindowLabel(validity);
  return React.createElement(
    "div",
    {
      className:
        "rounded border border-border bg-background/50 p-4 flex flex-col gap-2"
    },
    React.createElement(
      "h3",
      { className: SECTION_HEADING_CLASS },
      "Validity State"
    ),
    React.createElement(
      "div",
      { className: "flex items-center gap-2 text-xs" },
      React.createElement("span", { className: MUTED_TEXT_CLASS }, "State:"),
      React.createElement(
        "span",
        {
          className: `font-semibold ${validity.state === "verified" ? "text-success" : validity.state === "contradicted" ? "text-error" : "text-warning"}`
        },
        validity.state
      )
    ),
    validity.checkedAt
      ? React.createElement(
          "div",
          { className: MUTED_META_CLASS },
          `Checked at: ${new Date(validity.checkedAt).toLocaleString()}`
        )
      : null,
    validity.verificationSource
      ? React.createElement(
          "div",
          { className: MONO_META_CLASS },
          `Verification source: ${validity.verificationSource}`
        )
      : null,
    window === null
      ? null
      : React.createElement("div", { className: MONO_META_CLASS }, window),
    isValidityWindowClosed(validity, renderedAt)
      ? React.createElement(
          "div",
          { className: "text-error font-semibold" },
          "Out of validity window — the Runtime will not inject this claim."
        )
      : null
  );
}

export interface MemoryRecordsViewProps {
  readonly records: readonly MemoryRecord[];
  readonly total: number;
  readonly selectedRecord?: MemoryRecord | null | undefined;
  readonly history?: MemoryRecordHistory | null | undefined;
  /** The Runtime's eligibility-bounded explanation, when it was read. */
  readonly why?: ControlApiMemoryWhyResponse | null | undefined;
  /**
   * The address of the list these rows came from. Every link in this view —
   * opening a record, closing the drawer, reading a source experience,
   * paging — is built from it, so navigating within the list keeps the filters
   * and position that produced it.
   */
  readonly listScope: MemoryListScope;
}

const NOT_OBSERVED_STATUS = "not-observed" as const;

/** Names the transition-history list for assistive technology. */
const TRANSITION_HISTORY_HEADING_ID = "memory-transition-history";

const STATUS_VARIANT_MAP: Record<MemoryStatus, StatusBadgeVariant> = {
  active: "ready",
  proposed: "pending",
  invalidated: "invalid",
  superseded: "unavailable",
  uncertain: NOT_OBSERVED_STATUS
};

const KIND_COLORS: Record<MemoryKind, string> = {
  episodic: "bg-chart-4/15 text-chart-4 border-chart-4/40",
  semantic: "bg-chart-2/15 text-chart-2 border-chart-2/40",
  procedural: "bg-chart-3/15 text-chart-3 border-chart-3/40"
};
function formatScopeString(scope: MemoryScope): string {
  switch (scope.kind) {
    case "global": {
      return "global";
    }
    case "workspace": {
      return scope.workspaceId;
    }
    case "repository": {
      return scope.repositoryId;
    }
    case "role": {
      return `${scope.workspaceId} (@${scope.role})`;
    }
    case "task": {
      return `task:${scope.taskId}`;
    }
    case "agent": {
      return `agent:${scope.agentId}`;
    }
    default: {
      return "unknown";
    }
  }
}

export function MemoryRecordsView({
  records,
  total,
  selectedRecord,
  history,
  why,
  listScope
}: MemoryRecordsViewProps): React.JSX.Element {
  // One instant for the whole page, not one per record: a claim whose window
  // closes between two records' checks would otherwise render one as expired
  // and its neighbour as open, on the same screen, with nothing between them to
  // say why.
  const renderedAt = nowIso();
  const columns: ColumnDef<MemoryRecord>[] = [
    {
      id: "id",
      header: "Record ID",
      weight: 180,
      cell: (record) =>
        React.createElement(
          "a",
          {
            href: memoryDetailHref(listScope, "recordId", record.id),
            className:
              "font-mono text-xs font-semibold text-accent hover:brightness-110 hover:underline",
            "data-memory-record-id": record.id
          },
          record.id
        )
    },
    {
      id: "kind",
      header: "Kind",
      weight: 120,
      cell: (record) =>
        React.createElement(Tag, {
          className: `font-mono font-medium ${KIND_COLORS[record.kind] ?? "bg-surface-raised text-fg-secondary border-border-strong"}`,
          dataAttributes: { "data-memory-kind": record.kind },
          children: record.kind
        })
    },
    {
      id: "status",
      header: "Lifecycle Status",
      weight: 140,
      cell: (record) =>
        React.createElement(StatusBadge, {
          status: STATUS_VARIANT_MAP[record.status] ?? NOT_OBSERVED_STATUS,
          label: record.status.charAt(0).toUpperCase() + record.status.slice(1)
        })
    },
    {
      id: "claim",
      header: "Claim Summary",
      // Wide enough for "Summary", the longest word in the header. At 160 it
      // had 68px of content against a 69px word and split mid-word.
      weight: 172,
      cell: (record) =>
        React.createElement(
          "div",
          {
            className: "max-w-md truncate text-sm text-fg",
            title: record.claim
          },
          record.claim
        )
    },
    {
      id: "scope",
      header: "Scope",
      weight: 160,
      cell: (record) =>
        React.createElement(
          "span",
          {
            className:
              "font-mono text-xs text-fg-muted truncate max-w-[150px] inline-block",
            // A workspace-qualified scope is longer than 150px in every real
            // repository, so this column truncates on every row, not only on
            // the adversarial ones.
            title: formatScopeString(record.scope)
          },
          formatScopeString(record.scope)
        )
    },
    {
      id: "updatedAt",
      header: "Updated",
      weight: 140,
      cell: (record) =>
        React.createElement(
          "span",
          { className: MUTED_META_CLASS },
          record.updatedAt
            ? new Date(record.updatedAt).toLocaleDateString()
            : "unknown"
        )
    }
  ];

  return React.createElement(
    PageBody,
    { feature: "memory-records" },
    // Filter controls
    React.createElement(
      FilterBar,
      {
        label: "Record filters",
        // Submitting these controls changes *which* rows match, so the form
        // submits to the first page of the new list. The time window and page
        // size describe the list being narrowed and are carried through;
        // `memoryFilterHref` is the same rule for the links that follow.
        action: memoryFilterHref(listScope),
        preserved: [
          { name: "tab", value: "records" },
          { name: "workspaceId", value: listScope.workspaceId },
          { name: "from", value: listScope.from },
          { name: "until", value: listScope.until },
          { name: "limit", value: String(listScope.limit) }
        ],
        submitTestId: "memory-filter",
        summary: `${records.length} of ${total} records`,
        dataAttributes: { "data-feature-filter": "records" }
      },
      React.createElement(FilterSearchField, {
        name: "query",
        defaultValue: listScope.query ?? "",
        label: "Search memory claims",
        placeholder: "Search memory claims...",
        testId: "memory-record-query"
      }),
      React.createElement(SelectField, {
        name: "kind",
        label: "Kind:",
        defaultValue: listScope.kind ?? "all",
        testId: "memory-kind",
        options: [
          { value: "all", label: "All Kinds" },
          { value: "procedural", label: "Procedural" },
          { value: "semantic", label: "Semantic" },
          { value: "episodic", label: "Episodic" }
        ]
      }),
      React.createElement(SelectField, {
        name: "status",
        label: "Status:",
        defaultValue: listScope.status ?? "all",
        testId: "memory-status",
        options: [
          { value: "all", label: "All Statuses" },
          { value: "active", label: "Active" },
          { value: "proposed", label: "Proposed" },
          { value: "invalidated", label: "Invalidated" },
          { value: "superseded", label: "Superseded" },
          { value: "uncertain", label: "Uncertain" }
        ]
      })
    ),

    // Main records table
    React.createElement<DataTableProps<MemoryRecord>>(DataTable, {
      data: records,
      columns,
      keyExtractor: (r: MemoryRecord) => r.id,
      emptyMessage: "No memory records found matching the current criteria."
    }),

    // The Runtime returns a bounded page and the total behind it, so a
    // collection larger than one page needs a way to reach the rest.
    React.createElement(Pagination, {
      label: "Records",
      offset: listScope.offset,
      limit: listScope.limit,
      total,
      hrefForOffset: (offset: number) => memoryPageHref(listScope, offset),
      testId: "memory-records-pagination"
    }),

    // Selected record inspection drawer/panel
    selectedRecord
      ? React.createElement(RecordDetailPanel, {
          record: selectedRecord,
          history,
          why,
          listScope,
          renderedAt
        })
      : null
  );
}

/**
 * The experiences a record's claim was derived from.
 *
 * A claim is only as good as the evidence behind it, so "Sources: 2
 * experiences" was the one line on this panel an operator could not act on. The
 * ids are already in the record; all that was missing was somewhere to go with
 * them.
 *
 * `why` sharpens that: the Runtime reports which cited experiences *this*
 * reader can still resolve, and that set is allowed to be shorter than the
 * citation list. A record citing three sources of which one has fallen outside
 * the caller's scope is not a record with two sources, so the gap is named
 * rather than absorbed into the count.
 */
function ProvenanceSources({
  record,
  listScope,
  why
}: {
  readonly record: MemoryRecord;
  readonly listScope: MemoryListScope;
  readonly why?: ControlApiMemoryWhyResponse | null | undefined;
}): React.JSX.Element {
  const ids = record.provenance.experienceIds;
  if (ids.length === 0) {
    return React.createElement(
      "span",
      { "data-provenance-sources": "none" },
      "No source experiences are cited."
    );
  }
  const resolvable = why?.sourceExperiences.length;
  const unresolved =
    why === null || why === undefined
      ? null
      : Math.max(0, ids.length - (why.sourceExperiences.length ?? 0));
  return React.createElement(
    "div",
    { className: "flex flex-col gap-1", "data-provenance-sources": "linked" },
    React.createElement(
      "span",
      null,
      `Sources: ${ids.length} experience${ids.length === 1 ? "" : "s"}`
    ),
    ids.map((id) =>
      React.createElement(
        "a",
        {
          key: id,
          href: memoryExperienceHref(listScope, id),
          className: "font-mono text-accent hover:underline",
          "data-provenance-experience": id
        },
        id
      )
    ),
    // Read but unresolvable is a different fact from "not read": it is the
    // caller's scope, not the record, and an operator chasing a discrepancy
    // between two readers needs to be able to tell which one they are looking
    // at.
    unresolved === null || unresolved === 0
      ? unresolved === null
        ? null
        : React.createElement(
            "span",
            {
              className: MUTED_TEXT_CLASS,
              "data-provenance-unresolved": "false"
            },
            "All cited sources are resolvable to this reader."
          )
      : React.createElement(
          "span",
          { className: MUTED_TEXT_CLASS, "data-provenance-unresolved": "true" },
          `${resolvable} of ${ids.length} resolvable to this reader; the rest are outside this scope.`
        )
  );
}

interface RecordDetailPanelProps {
  readonly record: MemoryRecord;
  readonly history?: MemoryRecordHistory | null | undefined;
  readonly why?: ControlApiMemoryWhyResponse | null | undefined;
  readonly listScope: MemoryListScope;
  /** The page's single render instant, so every claim is judged against one clock. */
  readonly renderedAt: string;
}

function RecordDetailPanel({
  record,
  history,
  why,
  listScope,
  renderedAt
}: RecordDetailPanelProps): React.JSX.Element {
  // Computed once: the label is needed both to decide whether to render the row
  // and to fill it, and formatting the same window twice can produce two
  // different strings for one claim.
  return React.createElement(
    DetailDrawer,
    {
      title: record.id,
      // Back to the list the record was opened from, filters and position
      // intact. It used to link `?tab=records&workspaceId=…`, which dropped
      // the query, kind, status, and time window on the way out of the panel
      // the operator had just narrowed the list with.
      closeHref: memoryListHref(listScope),
      subtitle: `Scope: ${formatScopeString(record.scope)}`,
      dataAttributes: { "data-selected-record-panel": record.id },
      badges: [
        React.createElement(Tag, {
          key: "kind",
          className: `font-mono font-medium ${KIND_COLORS[record.kind] ?? "bg-surface-raised text-fg-secondary border-border-strong"}`,
          children: record.kind
        }),
        React.createElement(StatusBadge, {
          key: "status",
          status: STATUS_VARIANT_MAP[record.status] ?? NOT_OBSERVED_STATUS,
          label: record.status.toUpperCase()
        })
      ]
    },
    // Claim
    React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
        },
        "Durable Claim"
      ),
      React.createElement(CodeBlock, {
        content: record.claim,
        height: "auto",
        ariaLabel: "Durable claim",
        // A claim is monospace prose, not source, so it reads in the body text
        // colour and size rather than the editor's. Its box is otherwise the
        // same surface every other block of content on the page uses.
        className: "rounded-md text-sm text-fg"
      })
    ),

    // Validity & Provenance grid
    React.createElement(
      "div",
      { className: gridRowClass(2) },
      // Validity
      React.createElement(ValidityFacts, {
        validity: record.validity,
        renderedAt
      }),

      // Provenance
      React.createElement(
        "div",
        {
          className:
            "rounded border border-border bg-background/50 p-4 flex flex-col gap-2"
        },
        React.createElement(
          "h3",
          {
            className: SECTION_HEADING_CLASS
          },
          "Provenance & Citations"
        ),
        React.createElement(
          "div",
          { className: "text-xs text-fg-secondary" },
          // Each source is a link to the experience the claim was derived from.
          // It used to be a count: the panel said a claim had three sources and
          // offered no way to reach any of them, which is the one thing an
          // operator reading "Provenance & Citations" is there to do.
          React.createElement(ProvenanceSources, { record, listScope, why })
        ),
        record.provenance.lastVerifiedAt
          ? React.createElement(
              "div",
              { className: MONO_META_CLASS },
              `Last verified: ${new Date(record.provenance.lastVerifiedAt).toLocaleString()}`
            )
          : null,
        record.provenance.evidence && record.provenance.evidence.length > 0
          ? React.createElement(
              "div",
              { className: "flex flex-col gap-1 mt-1" },
              React.createElement(
                "span",
                { className: "text-xs text-fg-muted font-medium" },
                "Cited Evidence Files:"
              ),
              record.provenance.evidence.map(
                (ev: EvidenceReference, i: number) =>
                  // The shared chip rather than a fourth hand-typed tag: a URI
                  // is long enough to ellipsize in every repository, and the
                  // shared chip keeps the whole value on its hover title.
                  React.createElement(
                    Chip,
                    {
                      key: i,
                      className:
                        "border-accent/40 bg-accent/15 font-mono text-accent"
                    },
                    `${ev.kind}: ${ev.uri}`
                  )
              )
            )
          : null
      )
    ),

    // Lineage (supersedes / supersededBy)
    record.supersedes?.length || record.supersededBy?.length
      ? React.createElement(
          "div",
          { className: "flex flex-col gap-2 text-xs" },
          React.createElement(
            "h3",
            {
              className: SECTION_HEADING_CLASS
            },
            "Lineage"
          ),
          record.supersedes?.length
            ? React.createElement(
                "div",
                { className: "flex items-center gap-2" },
                React.createElement(
                  "span",
                  { className: MUTED_TEXT_CLASS },
                  "Supersedes:"
                ),
                record.supersedes.map((id) =>
                  React.createElement(
                    "a",
                    {
                      key: id,
                      href: memoryDetailHref(listScope, "recordId", id),
                      className: "font-mono text-accent hover:underline"
                    },
                    id
                  )
                )
              )
            : null,
          record.supersededBy?.length
            ? React.createElement(
                "div",
                { className: "flex items-center gap-2" },
                React.createElement(
                  "span",
                  { className: MUTED_TEXT_CLASS },
                  "Superseded By:"
                ),
                record.supersededBy.map((id) =>
                  React.createElement(
                    "a",
                    {
                      key: id,
                      href: memoryDetailHref(listScope, "recordId", id),
                      className: "font-mono text-accent hover:underline"
                    },
                    id
                  )
                )
              )
            : null
        )
      : null,

    // Transition History
    history && history.transitions && history.transitions.length > 0
      ? React.createElement(
          "div",
          { className: "flex flex-col gap-2" },
          React.createElement(
            "h3",
            {
              className: SECTION_HEADING_CLASS,
              id: TRANSITION_HISTORY_HEADING_ID
            },
            "Transition History"
          ),
          // An ordered list, not a stack of divs. Transitions are a sequence,
          // so assistive technology should be able to say how many there are
          // and that they are ordered; the box and the divider rules are
          // decoration on top of that structure rather than the only structure
          // it has. The heading names the list so it is not announced as an
          // anonymous group.
          React.createElement(
            "ol",
            {
              className:
                "flex flex-col divide-y divide-border rounded border border-border bg-background/60 list-none p-0 m-0",
              "aria-labelledby": TRANSITION_HISTORY_HEADING_ID,
              "data-transition-history": "observed"
            },
            history.transitions.map((t, i) =>
              React.createElement(
                "li",
                {
                  key: i,
                  className: "flex items-center justify-between p-3 text-xs"
                },
                React.createElement(
                  "div",
                  { className: "flex items-center gap-2" },
                  React.createElement(StatusBadge, {
                    status:
                      STATUS_VARIANT_MAP[t.toStatus] ?? NOT_OBSERVED_STATUS,
                    label: `${t.fromStatus ?? "none"} → ${t.toStatus}`
                  }),
                  t.reason
                    ? React.createElement(
                        "span",
                        { className: "text-fg-secondary" },
                        `(${t.reason})`
                      )
                    : null
                ),
                React.createElement(
                  "div",
                  {
                    className:
                      "flex items-center gap-3 text-fg-muted font-mono text-meta"
                  },
                  React.createElement("span", null, t.actor.id),
                  React.createElement(
                    "span",
                    null,
                    new Date(t.timestamp).toLocaleString()
                  )
                )
              )
            )
          )
        )
      : null,

    // Governed Operator Actions
    React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-center gap-3 pt-4 border-t border-border"
      },
      React.createElement(
        "span",
        {
          className:
            "text-xs font-semibold uppercase tracking-wider text-fg-muted mr-2"
        },
        "Governed Actions:"
      ),
      // Verify & Promote
      record.status === "proposed" || record.status === "invalidated"
        ? React.createElement(RecordActionForm, {
            record,
            listScope,
            action: "verify",
            label: "Verify & Promote",
            variant: "primary",
            testId: "memory-verify",
            withReason: true
          })
        : null,

      // Invalidate
      record.status === "active" || record.status === "proposed"
        ? React.createElement(RecordActionForm, {
            record,
            listScope,
            action: "invalidate",
            label: "Invalidate",
            variant: "destructive",
            testId: "memory-invalidate",
            withReason: true
          })
        : null,

      // Promote Procedure to RuleSync Skill
      record.kind === "procedural" && record.status === "active"
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(RecordActionForm, {
              record,
              listScope,
              action: "promote-skill",
              label: "Promote to RuleSync Skill",
              variant: "secondary",
              testId: "memory-promote-skill"
            }),
            // What the button will produce, before it is pressed. The promotion
            // creates the RuleSync skill but does not assign it: role assignment
            // lives in the execution contract, which is a separate write. So the
            // skill arrives exposed to nothing, and an operator told only "promoted"
            // would read that as a working skill.
            React.createElement(
              "p",
              {
                className: `${MUTED_META_CLASS} w-full basis-full`,
                "data-testid": "memory-promote-skill-consequence"
              },
              "Creates the RuleSync skill. It is not assigned to an agent role, so nothing can invoke it — assign it on the Skills page."
            )
          )
        : null
    ),

    // Revise lives outside the action row because it is the one lifecycle
    // action that is not a single click: the operator has to write the new
    // claim, and the route refuses `revise` without one.
    record.status === "active" || record.status === "uncertain"
      ? React.createElement(RecordActionForm, {
          record,
          listScope,
          action: "revise",
          label: "Revise Claim",
          variant: "secondary",
          testId: "memory-revise",
          withReason: true,
          claim: record.claim
        })
      : null
  );
}

/**
 * One governed record action, submitted to the Console's own memory route.
 *
 * The three lifecycle forms were written out separately and differed only in
 * three hidden fields and a button label, so a fourth action -- `revise` -- would
 * have been a fourth copy of the same block, and the one that most needs a
 * reason and a claim is the one most likely to be built without them. Keeping
 * the shape in one place is what makes "does this action carry an audit reason?"
 * a single question with a single answer.
 */
interface RecordActionFormProps {
  readonly record: MemoryRecord;
  readonly listScope: MemoryListScope;
  readonly action: "verify" | "invalidate" | "revise" | "promote-skill";
  readonly label: string;
  readonly variant: "primary" | "secondary" | "destructive";
  readonly testId: string;
  /**
   * Offer an audit-reason box.
   *
   * Every lifecycle transition records an append-only reason, and the route
   * substituted a canned sentence when the form sent none -- so the audit trail
   * could not distinguish "verified against the passing suite" from "verified
   * because it looked right". Leaving it blank is allowed and falls back to that
   * sentence; it just stops being the only option.
   */
  readonly withReason?: boolean | undefined;
  /** Pre-fill for a revision's replacement claim. */
  readonly claim?: string | undefined;
}

function RecordActionForm({
  record,
  listScope,
  action,
  label,
  variant,
  testId,
  withReason,
  claim
}: RecordActionFormProps): React.JSX.Element {
  const hidden = (name: string, value: string): React.JSX.Element =>
    React.createElement("input", { key: name, type: "hidden", name, value });
  return React.createElement(
    "form",
    {
      method: "POST",
      action: "/api/memory",
      // The reason and claim boxes sit above the button, so the row this form
      // occupies grows with its content rather than with the label.
      className: "flex flex-wrap items-end gap-2"
    },
    hidden("action", action),
    hidden("recordId", record.id),
    hidden("workspaceId", listScope.workspaceId),
    // The list this action was made on, so the route's redirect lands back
    // inside the filters the operator was working in rather than at the top of
    // an unfiltered 30-day list.
    hidden("returned", memoryListQuery(listScope)),
    claim === undefined
      ? null
      : React.createElement(TextField, {
          name: "claim",
          id: `memory-revise-claim-${record.id}`,
          label: "Revised claim",
          hideLabel: true,
          defaultValue: claim,
          rows: 3,
          className: "basis-64 grow",
          testId: "memory-revise-claim"
        }),
    withReason === true
      ? React.createElement(TextField, {
          name: "reason",
          id: `memory-${action}-reason-${record.id}`,
          label: `Reason for ${label.toLowerCase()}`,
          hideLabel: true,
          placeholder: "Why this transition?",
          className: "basis-56 grow",
          testId: `memory-${action}-reason`
        })
      : null,
    React.createElement(Button, { type: "submit", variant, testId }, label)
  );
}
