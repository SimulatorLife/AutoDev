import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { copilotMcpArgs, runCopilot } from "../src/providers/copilot.ts";
import {
  EXECUTION_CONTRACT,
  roleContract
} from "../src/shared/execution-contract.ts";
import { createBridgeMcpHomes } from "./bridge-mcp-fixture.ts";

type McpServer = {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  tools: string[];
};
type ParsedMcpArgs = {
  builtinDisabled: boolean;
  disabled: string[];
  additional: Record<string, McpServer>;
  allowed: string[];
};

type RoleContractWithTools = ReturnType<typeof roleContract> & {
  mcpTools?: Record<string, string[]>;
};

const homes = createBridgeMcpHomes();
process.env.CODEX_HOME = homes.codexHome;
process.env.COPILOT_HOME = homes.copilotHome;
const catalogue = JSON.parse(await readFile(homes.catalogue, "utf8")) as Record<
  string,
  McpServer
>;
const copilotConfig = JSON.parse(
  await readFile(join(homes.copilotHome, "mcp-config.json"), "utf8")
) as { mcpServers: Record<string, McpServer> };
const userServers = Object.keys(copilotConfig.mcpServers);

test.after(async () => {
  await rm(homes.root, { recursive: true, force: true });
});

function parse(args: readonly string[]): ParsedMcpArgs {
  const parsed: ParsedMcpArgs = {
    builtinDisabled: false,
    disabled: [],
    additional: {},
    allowed: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--disable-builtin-mcps") parsed.builtinDisabled = true;
    else if (arg === "--disable-mcp-server")
      parsed.disabled.push(args[(index += 1)] ?? "");
    else if (arg === "--additional-mcp-config") {
      const value = JSON.parse(args[(index += 1)] ?? "{}") as {
        mcpServers?: Record<string, McpServer>;
      };
      parsed.additional = value.mcpServers ?? {};
    } else if (arg?.startsWith("--allow-tool="))
      parsed.allowed.push(arg.slice("--allow-tool=".length));
  }
  return parsed;
}

test("every Copilot turn sees exactly its role contract's MCP servers", () => {
  for (const role of Object.keys(EXECUTION_CONTRACT.roles)) {
    const contract = roleContract(role) as RoleContractWithTools;
    const granted = contract.mcp.filter((name) => name !== "autodev_spawn");
    const { builtinDisabled, disabled, additional, allowed } = parse(
      copilotMcpArgs(role)
    );
    assert.equal(
      builtinDisabled,
      true,
      `${role}: the built-in GitHub MCP server is outside every contract`
    );
    assert.deepEqual(
      disabled.sort(),
      userServers.filter((name) => !granted.includes(name)).sort(),
      `${role}: disabled user-level servers`
    );
    assert.deepEqual(
      Object.keys(additional).sort(),
      granted.filter((name) => !userServers.includes(name)).sort(),
      `${role}: added servers`
    );
    assert.deepEqual(allowed, granted, `${role}: approved servers`);
    for (const [name, server] of Object.entries(additional)) {
      const launch = catalogue[name];
      assert.ok(launch, `${role}/${name}: missing launch metadata`);
      assert.deepEqual(
        server.tools,
        contract.mcpTools?.[name] ?? ["*"],
        `${role}/${name}: tool allowlist`
      );
      if (launch.url)
        assert.deepEqual(
          server,
          { type: "http", url: launch.url, tools: server.tools },
          `${role}/${name}`
        );
      else
        assert.deepEqual(
          server,
          {
            type: "stdio",
            command: launch.command,
            args: launch.args,
            tools: server.tools
          },
          `${role}/${name}`
        );
    }
  }
});

test("browser roles get the pinned Playwright launcher with the role's tool allowlist, and nobody else does", () => {
  for (const role of ["browser-tester", "smart"]) {
    const { additional } = parse(copilotMcpArgs(role));
    assert.ok(additional.playwright, `${role}: missing Playwright server`);
    assert.ok(
      catalogue.playwright,
      `${role}: missing Playwright catalogue entry`
    );
    assert.deepEqual(
      additional.playwright.args,
      catalogue.playwright.args,
      role
    );
    const contract = roleContract(role) as RoleContractWithTools;
    assert.ok(
      contract.mcpTools?.playwright && contract.mcpTools.playwright.length > 0,
      `${role} declares enabled_tools`
    );
    assert.deepEqual(
      additional.playwright.tools,
      contract.mcpTools.playwright,
      role
    );
  }
  for (const role of [
    "default",
    "explorer",
    "worker",
    "validator",
    "docs-researcher",
    "orchestrator"
  ]) {
    assert.equal(
      "playwright" in parse(copilotMcpArgs(role)).additional,
      false,
      role
    );
  }
  assert.deepEqual(parse(copilotMcpArgs("browser-tester")).disabled.sort(), [
    "cocoindex-code",
    "lsp"
  ]);
  const docsAdditional = parse(copilotMcpArgs("docs-researcher")).additional
    .openaiDeveloperDocs;
  const docsCatalogue = catalogue.openaiDeveloperDocs;
  assert.ok(docsAdditional);
  assert.ok(docsCatalogue);
  assert.deepEqual(docsAdditional.url, docsCatalogue.url);
});

test("a missing bridge MCP catalogue fails the turn instead of guessing servers", () => {
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(homes.root, "absent");
  try {
    assert.throws(
      () => copilotMcpArgs("explorer"),
      /bridge MCP catalogue is missing or invalid.*rerun scripts\/install\.sh/
    );
  } finally {
    process.env.CODEX_HOME = saved;
  }
});

test("runCopilot hands the role's MCP arguments to the Copilot CLI", async () => {
  const fakeCli = join(homes.root, "fake-copilot.mjs");
  const argsFile = join(homes.root, "copilot-args.json");
  await writeFile(
    fakeCli,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`,
    "utf8"
  );
  await chmod(fakeCli, 0o755);
  const saved = process.env.COPILOT_BIN;
  process.env.COPILOT_BIN = fakeCli;
  try {
    await runCopilot(
      "task",
      "copilot",
      homes.root,
      () => {},
      "browser-tester"
    ).catch(() => {});
  } finally {
    if (saved === undefined) delete process.env.COPILOT_BIN;
    else process.env.COPILOT_BIN = saved;
  }
  const argv = JSON.parse(await readFile(argsFile, "utf8"));
  const expected = copilotMcpArgs("browser-tester");
  const start = argv.indexOf(expected[0]);
  assert.deepEqual(argv.slice(start, start + expected.length), expected);
});
