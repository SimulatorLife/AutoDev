import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_API_CONTRACT } from "@simulatorlife/autodev-core";

import { verifyControlApiCompatibility } from "../src/cli/control-api-compatibility.ts";

const config = {
  baseUrl: "http://control-api.test",
  serviceToken: "control-api-compatibility-test-token"
};

function controlApiFixture(
  overrides: Readonly<Record<string, Response>> = {}
): { readonly fetch: typeof fetch; readonly paths: string[] } {
  const paths: string[] = [];
  const responses: Readonly<Record<string, Response>> = {
    "/control/contracts": Response.json({
      schema: CONTROL_API_CONTRACT.schema,
      version: CONTROL_API_CONTRACT.version
    }),
    "/control/providers": Response.json({
      schema: "autodev-control-providers-v2",
      providers: []
    }),
    "/control/provider-models": Response.json({
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: []
    }),
    "/control/playtesting/capabilities": Response.json(
      {
        error: {
          code: "autodev_control_playtesting_workspace_not_found",
          message: "The probe workspace is not configured."
        }
      },
      { status: 404 }
    ),
    "/control/playtesting/readiness": Response.json(
      {
        error: {
          code: "autodev_control_playtesting_workspace_not_found",
          message: "The probe workspace is not configured."
        }
      },
      { status: 404 }
    ),
    ...overrides
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${config.serviceToken}`
    );
    return responses[url.pathname] ?? Response.json({}, { status: 404 });
  };
  return { fetch, paths };
}

test("Console compatibility requires and probes the typed Playtesting readiness route", async () => {
  const fixture = controlApiFixture();
  await verifyControlApiCompatibility(config, fixture.fetch);
  assert.deepEqual(fixture.paths, [
    "/control/contracts",
    "/control/providers",
    "/control/provider-models",
    "/control/playtesting/capabilities",
    "/control/playtesting/readiness"
  ]);
});

test("an unknown Playtesting readiness path refuses Console startup", async () => {
  const fixture = controlApiFixture({
    "/control/playtesting/readiness": Response.json(
      {
        error: {
          code: "autodev_control_playtesting_unknown_path",
          message: "Unknown Playtesting resource path."
        }
      },
      { status: 404 }
    )
  });
  await assert.rejects(
    verifyControlApiCompatibility(config, fixture.fetch),
    /Playtesting readiness endpoint is missing/u
  );
});
