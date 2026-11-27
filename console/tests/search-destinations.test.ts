import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesSearchDestination,
  searchDestinations,
  searchFailureMessage} from "../src/components/navigation/search-destinations.ts";

test("search indexes canonical providers, models, roles, and workspace records with their real routes", () => {
  const results = searchDestinations({
    providers: { providers: [{ id: "codex" }] } as never,
    models: {
      models: [{ id: "gpt-5", provider: "codex", displayName: "GPT Five" }]
    } as never,
    agents: {
      agents: [{ id: "worker-agent-id", role: "worker" }]
    } as never,
    workspaces: {
      catalogStatus: "valid",
      workspaces: [{ id: "owner/repo" }]
    } as never
  });
  assert.deepEqual(
    results.map(({ type, path }) => [type, path]),
    [
      ["Provider", "/providers/codex"],
      ["Model", "/providers/codex/models/gpt-5"],
      ["Agent role", "/agents/worker-agent-id"],
      ["Workspace", "/workspaces/owner/repo"]
    ]
  );
  assert.equal(matchesSearchDestination(results[1]!, "gpt codex"), true);
  assert.equal(matchesSearchDestination(results[3]!, "owner repo"), true);
  assert.equal(matchesSearchDestination(results[0]!, "PROVIDER CODEX"), true);
  assert.equal(matchesSearchDestination(results[2]!, "absent"), false);
});

test("search failure status distinguishes partial and total record-source failures", () => {
  assert.match(
    searchFailureMessage(["models"]),
    /^Some search records are unavailable: Models\./u
  );
  assert.match(
    searchFailureMessage([
      "configuration",
      "providers",
      "models",
      "agentRoles",
      "workspaces"
    ]),
    /^Search records are unavailable: search configuration/u
  );
  assert.match(
    searchFailureMessage([
      "endpoint",
      "providers",
      "models",
      "agentRoles",
      "workspaces"
    ]),
    /Section results remain available\. Reopen Search to retry\.$/u
  );
});
