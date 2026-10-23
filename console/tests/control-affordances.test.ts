import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Button,
  DESTRUCTIVE_BUTTON_CLASS,
  OUTLINE_BUTTON_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from "../src/components/forms/Button.ts";
import { AppNav } from "../src/components/navigation/AppNav.ts";
import {
  STATE_PILL_BUTTON_CLASS,
  STATE_PILL_TONE_CLASS
} from "../src/components/ui/state-pill.ts";
import { mcpDetailTabs } from "../src/features/mcps/McpDetailView.ts";
import { PromptsView } from "../src/features/prompts/PromptsView.ts";
import { ProvidersView } from "../src/features/providers/ProvidersView.ts";
import { ToolsView } from "../src/features/tools/ToolsView.ts";

/**
 * The Console's control affordances.
 *
 * Two properties are pinned here, and both are the kind that look fine in the
 * source and wrong on the page.
 *
 * The pointer is the primary signal that a control is clickable. Every button
 * in the Console -- "Apply filters", "Reset to defaults", the provider row's
 * limit steppers -- rendered with the default arrow while looking and behaving
 * like a button, so the cursor contradicted the chrome on every page. The
 * Console's own newer surfaces spelled `cursor-pointer` inline instead, which
 * left the same role with two spellings and the shared vocabulary with none.
 *
 * A table header is a label, and the shared table contract says a column's
 * weight must be large enough for its own header. Two headers were smaller
 * than their own names: "Active Agents" wrapped to two lines, and "Requests"
 * pushed its help marker onto a line of its own, under the label it explains.
 * The same table header then measured 35.5px on twelve pages and 50.5px on
 * those two, so the header rhythm was not the Console's rhythm.
 */

const BUTTON_VARIANT_CLASSES = [
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  DESTRUCTIVE_BUTTON_CLASS,
  OUTLINE_BUTTON_CLASS
];

/**
 * A provider that holds a routing slot in two capability tiers.
 *
 * Two tiers is the case the links list has to survive: the provider's name is
 * visible three times on the page -- once in the providers table, once per
 * routing tier -- and only the name is on the surface.
 */
const NO_CONVERGENCE = {
  convergence: "not-observed" as const,
  desiredGeneration: null,
  observedGeneration: null,
  lastApplyAt: null,
  lastObservationAt: null,
  lastError: null,
  explanation: "Not observed."
};

const PROVIDERS_FIXTURE = {
  schema: "autodev-control-providers-v3",
  orchestratorTier: "root",
  tiers: [
    { tier: "default", groups: [["provider-fixture"]] },
    { tier: "root", groups: [["provider-fixture"]] }
  ],
  providers: [
    {
      id: "provider-fixture",
      links: { usage: null, documentation: null },
      route: null,
      credential: { envKey: null, configured: false },
      disabled: false,
      roles: {
        default: {
          priority: "disabled",
          model: null,
          mutable: false,
          convergence: NO_CONVERGENCE
        },
        smart: {
          priority: "disabled",
          model: null,
          mutable: false,
          convergence: NO_CONVERGENCE
        },
        orchestrator: {
          priority: "disabled",
          model: null,
          mutable: false,
          convergence: NO_CONVERGENCE
        },
        subagent: {
          priority: "disabled",
          model: null,
          mutable: false,
          convergence: NO_CONVERGENCE
        }
      },
      agentLimits: null,
      models: [],
      priorities: [],
      orchestratorReasoningEffort: null,
      health: {
        cooldown: null,
        failureStreak: 0,
        probeFailureStreak: 0,
        inFlightRequests: 0,
        activeAgents: 0,
        attempts: 0,
        successes: 0,
        failures: 0,
        lastSuccessAt: null,
        lastFailure: null
      },
      reconciliation: { status: NO_CONVERGENCE, history: [] }
    }
  ]
};

test("every button variant is a pointer target", () => {
  for (const variantClass of BUTTON_VARIANT_CLASSES) {
    assert.match(
      variantClass,
      /\bcursor-pointer\b/u,
      "a button that looks clickable must not show the default arrow"
    );
  }
});

test("a disabled button keeps the not-allowed cursor", () => {
  for (const variantClass of BUTTON_VARIANT_CLASSES) {
    assert.match(
      variantClass,
      /disabled:cursor-not-allowed/u,
      "a disabled control is still a target, and says so"
    );
  }
});

/**
 * A control that is working is not an unavailable control.
 *
 * A disabled control is dropped out of the page's focus order the moment it is
 * disabled, so the operator who pressed it loses their place in the document
 * and the next Tab starts from the top of the page. That is exactly what the
 * prompt preview did: its control was disabled while the request was in
 * flight, and the browser moved the focus to the document the moment it was.
 *
 * The shared vocabulary says "busy" for that state, so a control that is
 * working keeps its place in the page and says it is unavailable while it is.
 */
test("a busy button is working, not unavailable", () => {
  const markup = renderToStaticMarkup(
    React.createElement(Button, { busy: true }, "Approving…")
  );

  assert.doesNotMatch(
    markup,
    /\sdisabled(?:="|[\s>])/u,
    "a busy control keeps its place in the page's focus order"
  );
  assert.match(
    markup,
    /aria-disabled="true"/u,
    "the control has to say it is unavailable while it works"
  );
  assert.match(
    markup,
    /data-submitting="true"/u,
    "the busy state is published the way the Console's own form owner publishes it"
  );
});

test("a disabled button is still disabled", () => {
  const markup = renderToStaticMarkup(
    React.createElement(Button, { disabled: true }, "Approve")
  );

  assert.match(markup, /\sdisabled(?:="|[\s>])/u);
  assert.doesNotMatch(
    markup,
    /aria-disabled="true"/u,
    "an unavailable control is not a control that is working"
  );
});

test("a busy button does not act", () => {
  // The action a busy button stands for is already happening, so the second
  // press is refused by the vocabulary rather than by the caller's handler.
  // That is what makes the busy state a safe replacement for a control that
  // used to be disabled while it worked: the operator keeps their place in the
  // page and the request happens once.
  const press = (): void => {};
  const busy = Button({ busy: true, onClick: press, children: "Approving…" });
  assert.equal(
    busy.props.onClick,
    undefined,
    "a busy control must not act on a second press"
  );

  const idle = Button({ onClick: press, children: "Approve" });
  assert.equal(idle.props.onClick, press, "an idle control acts");
});

test("every button variant dims a busy control the way it dims a disabled one", () => {
  for (const variantClass of BUTTON_VARIANT_CLASSES) {
    assert.match(
      variantClass,
      /aria-disabled:opacity-60/u,
      "a busy control wears the unavailable chrome"
    );
    assert.match(
      variantClass,
      /aria-disabled:cursor-not-allowed/u,
      "a busy control is still a target, and says the action is not available"
    );
  }
});

test("the rendered button carries the pointer and its own variant's class", () => {
  for (const [variant, variantClass] of [
    ["primary", PRIMARY_BUTTON_CLASS],
    ["secondary", SECONDARY_BUTTON_CLASS],
    ["destructive", DESTRUCTIVE_BUTTON_CLASS],
    ["outline", OUTLINE_BUTTON_CLASS]
  ] as const) {
    const markup = renderToStaticMarkup(
      React.createElement(Button, { variant }, "Apply filters")
    );
    assert.match(markup, /\bcursor-pointer\b/u);
    for (const token of variantClass.split(" ")) {
      assert.ok(
        markup.includes(token),
        `the ${variant} button must carry "${token}"`
      );
    }
  }
});

/**
 * A control that shows a state and can change it is one control, not two.
 *
 * The agent enablement pill and the model enablement pill were the same
 * control written twice -- the same chrome string, the same three tones, and
 * the same paragraph explaining why the hover strengthens the border instead
 * of tinting the fill. Two features changing the same vocabulary is how they
 * drift apart, and they had already drifted: neither spelling carried a
 * pointer cursor, so a control that shows a state and takes a click still
 * pointed at nothing.
 */
test("the state-coloured button is one vocabulary, and it is a pointer target", () => {
  assert.match(
    STATE_PILL_BUTTON_CLASS,
    /\bcursor-pointer\b/u,
    "a pill that applies a change is a pointer target"
  );
  assert.match(STATE_PILL_BUTTON_CLASS, /disabled:cursor-not-allowed/u);

  // The two features must not spell the vocabulary themselves.
  for (const source of [
    "../src/features/agents/AgentEnablementControl.ts",
    "../src/features/providers/ModelToggle.ts"
  ]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.match(
      text,
      /STATE_PILL_BUTTON_CLASS/u,
      `${source} must use the shared state-pill vocabulary`
    );
    assert.doesNotMatch(
      text,
      /bg-success\/15 text-success border-success\/60/u,
      `${source} must not spell the tones itself`
    );
  }
});

test("the three state tones are the ones the pill has always had", () => {
  assert.deepEqual(Object.keys(STATE_PILL_TONE_CLASS).sort(), [
    "off",
    "on",
    "unknown"
  ]);
  assert.match(STATE_PILL_TONE_CLASS.on, /text-success/u);
  assert.match(STATE_PILL_TONE_CLASS.off, /text-warning/u);
  assert.match(STATE_PILL_TONE_CLASS.unknown, /text-fg-muted/u);
});

/**
 * The help marker explains the label it sits beside, so the two are one unit.
 *
 * They were two inline spans, which left the line break as the only thing
 * between them: when a column was a few pixels too narrow the marker dropped
 * onto a line of its own. A flex row keeps them together -- the label still
 * wraps inside itself, and the marker stays beside it.
 */
test("a column help marker is bound to its label rather than floating after it", () => {
  const source = readFileSync(
    new URL("../src/components/tables/DataTable.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /data-column-header/u,
    "the header label and its marker must share a group"
  );
  assert.match(source, /"flex items-start gap-1\.5"/u);
  assert.doesNotMatch(
    source,
    /"ml-1\.5 inline-flex cursor-help/u,
    "the marker's spacing is the group's gap now, not a margin that can separate it"
  );
  assert.match(
    source,
    /shrink-0/u,
    "the marker must not be the part that shrinks"
  );
});

/**
 * The page's outline starts with the page.
 *
 * The sidebar is chrome: it is on every page and it sits before the shell
 * header in the document, so its group labels came first in every page's
 * heading outline -- three navigation headings ahead of the page's own title,
 * and at the same level as the page's body sections. An operator navigating
 * by heading met "Configure", "Observe" and "Operate" before they met the
 * page they were on.
 *
 * The group is still a labelled region: `aria-labelledby` names it from its
 * label element, and a labelled region does not need a heading for that.
 */
test("the navigation's group labels are labels, not headings of the page", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AppNav, {
      activeSection: "Agents",
      counts: { Agents: 8, MCPs: 5 }
    })
  );
  assert.doesNotMatch(
    markup,
    /<h[1-6][^>]*>/u,
    "the navigation must not add headings to the page's outline"
  );
  for (const groupId of ["Configure", "Observe", "Operate"]) {
    const labelId = `autodev-nav-group-${groupId.toLowerCase()}`;
    assert.ok(
      markup.includes(`id="${labelId}"`),
      `the ${groupId} group must keep its label element`
    );
    assert.ok(
      markup.includes(`aria-labelledby="${labelId}"`),
      `the ${groupId} group must stay a labelled region`
    );
  }
});

/**
 * A scroll region has to say that it scrolls.
 *
 * A table's declared widths are a content budget, and the region scrolls when
 * the viewport cannot provide it -- by design. macOS hides overlay scrollbars
 * until you scroll, so the region gave the operator nothing to act on: a
 * table whose last column was cut in half read as a rendering fault rather
 * than as more content to the right.
 */
test("the Console's scroll regions are visible", () => {
  const css = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8"
  );
  assert.match(
    css,
    /scrollbar-width:\s*thin/u,
    "a scroll region must show that it scrolls"
  );
  assert.match(
    css,
    /scrollbar-color:[^;]*var\(--color-border-strong\)/u,
    "the scrollbar must wear the Console's own token"
  );
});

/**
 * A link's name has to say what it points at.
 *
 * Three tables repeated one name per row: every prompt carried an
 * "Evaluations" link, every tool repeated a filter link per exposed role, and
 * every agent repeated a provider link. The links were correct -- each one
 * pointed at its own row -- but a links list, which is how a screen reader
 * user scans a page, showed "Evaluations" seventy-six times and
 * "Filter tools exposed to smart" twenty-four times, with nothing to tell
 * the entries apart.
 *
 * The visible text stays short -- a chip says "Evaluations" -- and the
 * accessible name carries the row. The name still contains the visible text,
 * which is what keeps a voice-control user able to say what they see.
 */
test("a repeated link names the row it belongs to", () => {
  const prompts = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: [
        {
          name: "dry",
          path: ".rulesync/commands/dry.md",
          description: "Dry-run command"
        },
        {
          name: "wet",
          path: ".rulesync/commands/wet.md",
          description: "Wet-run command"
        }
      ],
      validationIssues: [],
      commandSourceValidity: true
    })
  );
  assert.match(prompts, /aria-label="Evaluations for dry"/u);
  assert.match(prompts, /aria-label="Evaluations for wet"/u);

  const tools = renderToStaticMarkup(
    React.createElement(ToolsView, {
      tools: [
        {
          id: "analyze_code_relationships",
          name: "analyze_code_relationships",
          description: "Analyze code relationships",
          source: "mcp",
          exposedRoles: ["smart"]
        }
      ],
      coverage: { schema: "x", source: "y" } as never,
      validity: "valid",
      usageLink: "/usage",
      filters: { source: "", role: "" }
    } as unknown as React.ComponentProps<typeof ToolsView>)
  );
  assert.match(
    tools,
    /aria-label="Filter tools exposed to smart for analyze_code_relationships"/u
  );
});

/**
 * A tab and a top-level page can share a label.
 *
 * The "Tools" tab on an MCP server and the Tools catalog are two different
 * destinations, and the navigation carries both on every page. A links list
 * then shows "Tools" twice with nothing to tell the entries apart, so the tab
 * says which server's tools it opens. The visible label does not change, and
 * the name still contains it.
 */
test("a tab that shares a label with a page says which page it belongs to", () => {
  const tabs = mcpDetailTabs("cocoindex-code");
  const tools = tabs.find((tab) => tab.id === "tools");
  const prompts = tabs.find((tab) => tab.id === "prompts");
  const overview = tabs.find((tab) => tab.id === "overview");
  assert.equal(tools?.label, "Tools", "the visible label does not change");
  assert.equal(tools?.ariaLabel, "Tools for cocoindex-code");
  assert.equal(prompts?.ariaLabel, "Prompts for cocoindex-code");
  assert.equal(
    overview?.ariaLabel,
    undefined,
    "a tab that shares no label with a page needs no name of its own"
  );
});

/**
 * A section heading that repeats the page's own title says nothing.
 *
 * The shell renders the page's `h1` from the canonical section name -- "Tools",
 * "Providers" -- so a section heading with the same words adds a level to the
 * outline that carries no information, and the operator navigating by heading
 * meets the page's own name twice.
 *
 * `/providers` did exactly that: an `h2` reading "Providers" under an `h1`
 * reading "Providers", with a table header reading "PROVIDER" beneath it.
 * `/tools` had the opposite fault: the only catalog page whose table arrived
 * with no heading at all, so scanning the outline found nothing between the
 * page title and the table.
 */
test("a section heading names the section rather than repeating the page", () => {
  const providers = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: PROVIDERS_FIXTURE,
      models: { status: "unavailable", message: "Fixture not observed." },
      modelDiscovery: { status: "unavailable", message: "Fixture not observed." }
    } as unknown as React.ComponentProps<typeof ProvidersView>)
  );

  const headings = new Set(Array.from(providers.matchAll(/<h2[^>]*>([^<]*)</gu), (match) => match[1] ?? ""));
  assert.ok(
    headings.has("Configured Providers"),
    "the providers section has to say which providers it lists"
  );
  assert.ok(
    !headings.has("Providers"),
    "a section heading that repeats the page's own title says nothing"
  );

  const tools = renderToStaticMarkup(
    React.createElement(ToolsView, {
      tools: [],
      coverage: "partial",
      validity: "valid",
      usageLink: "/usage",
      filters: { source: "", role: "" }
    } as unknown as React.ComponentProps<typeof ToolsView>)
  );
  const toolHeadings = Array.from(tools.matchAll(/<h2[^>]*>([^<]*)</gu), (match) => match[1] ?? "");
  assert.ok(
    toolHeadings.length > 0,
    "every catalog page names the section its table belongs to"
  );
  assert.ok(
    !toolHeadings.includes("Tools"),
    "a section heading that repeats the page's own title says nothing"
  );
});

/**
 * The same link, twice, has to say which one is which.
 *
 * A provider appears on `/providers` more than once: once in the providers
 * table, and once for every capability tier it holds a routing slot in. The
 * visible text is the provider's name in all of those places, so the accessible
 * name has to carry the slot -- otherwise a links list, which is how a screen
 * reader user scans the page, showed "Open provider claude" three times with
 * nothing to tell the entries apart.
 */
test("a provider link names the routing slot it points at", () => {
  const providers = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: PROVIDERS_FIXTURE,
      models: { status: "unavailable", message: "Fixture not observed." },
      modelDiscovery: { status: "unavailable", message: "Fixture not observed." }
    } as unknown as React.ComponentProps<typeof ProvidersView>)
  );

  const names = Array.from(providers.matchAll(/aria-label="(Open provider [^"]*)"/gu), (match) => match[1] ?? "");
  assert.equal(
    new Set(names).size,
    names.length,
    "two links with the same name are two links the operator cannot tell apart"
  );
  assert.ok(
    names.some((name) => name.includes("tier")),
    "the routing-priority links name the slot they point at"
  );
  assert.ok(
    names.every((name) => name.includes("provider-fixture")),
    "the name still contains the provider's visible name, so voice control works"
  );
});
