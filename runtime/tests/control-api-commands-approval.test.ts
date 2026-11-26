import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleControlApiRequest } from "../src/control-api/request-handler.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

/**
 * The Commands backend serves an operator-approved catalogue, and the approval
 * is the operator's answer to "which revision is live?".
 *
 * The catalogue exists twice: as a proposal in the checkout and as an approved
 * copy outside every workspace. The approved copy is the one the backend
 * serves, so the state published on the backend's own entry is what an
 * operator needs to see it.
 */

const SERVICE_TOKEN = "s".repeat(64);
const OPERATOR_ACTOR = "test-operator";

const CATALOGUE = {
  version: 1,
  commands: {
    typecheck: {
      description: "Run project type checking.",
      executable: "pnpm",
      args: ["run", "typecheck"],
      timeoutMs: 300000,
      executionClass: "validation",
      concurrency: "exclusive"
    }
  }
};

function request(method: string, url: string, actor: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    url,
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-autodev-actor": actor
    }
  }) as unknown as IncomingMessage;
}

interface Harness {
  readonly repositoryRoot: string;
  readonly autodevHome: string;
  readonly codexHome: string;
  readonly restore: () => void;
  readonly call: (
    method: string,
    pathname: string
  ) => Promise<{
    status: number;
    body: Record<string, unknown> | null;
  }>;
}

/**
 * A checkout that proposes one catalogue and two Runtime homes that may or may
 * not hold an approved copy of it.
 */
function harness(
  options: {
    readonly proposal?: unknown;
    readonly approvedHomes?: readonly ("autodev" | "codex")[];
    readonly approvedContent?: string;
  } = {}
): Harness {
  const root = mkdtempSync(join(tmpdir(), "autodev-commands-approval-"));
  const repositoryRoot = join(root, "repo");
  const autodevHome = join(root, "autodev");
  const codexHome = join(root, "codex");
  mkdirSync(join(repositoryRoot, "config"), { recursive: true });
  // The canonical declaration that names the backend the Console reads.
  mkdirSync(join(repositoryRoot, ".rulesync"), { recursive: true });
  writeFileSync(
    join(repositoryRoot, ".rulesync", "mcp.jsonc"),
    `${JSON.stringify(
      {
        mcpServers: {
          commands: {
            command: "bash",
            args: [
              "-lc",
              'exec "${AUTODEV_HOME:-$HOME/.autodev}/hooks/run-autodev-mcp.sh" commands'
            ]
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFileSync(
    join(repositoryRoot, "config", "commands.json"),
    `${JSON.stringify(options.proposal ?? CATALOGUE, null, 2)}\n`,
    "utf8"
  );
  for (const home of options.approvedHomes ?? []) {
    const homePath = home === "autodev" ? autodevHome : codexHome;
    mkdirSync(join(homePath, "config"), { recursive: true });
    writeFileSync(
      join(homePath, "config", "commands.json"),
      options.approvedContent ?? `${JSON.stringify(CATALOGUE, null, 2)}\n`,
      "utf8"
    );
  }

  const previousHome = process.env.HOME;
  const previousAutoDevHome = process.env.AUTODEV_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.HOME = root;
  process.env.AUTODEV_HOME = autodevHome;
  process.env.CODEX_HOME = codexHome;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;

  return {
    repositoryRoot,
    autodevHome,
    codexHome,
    restore: () => {
      const restoreEnv = (name: string, previous: string | undefined): void => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      };
      restoreEnv("HOME", previousHome);
      restoreEnv("AUTODEV_HOME", previousAutoDevHome);
      restoreEnv("CODEX_HOME", previousCodexHome);
      restoreEnv("AUTODEV_CONTROL_API_TOKEN", previousToken);
      restoreEnv("AUTODEV_CONTROL_OPERATORS", previousOperators);
    },
    call: async (method, pathname) => {
      const response = responseRecorder();
      await handleControlApiRequest(
        request(method, pathname, OPERATOR_ACTOR),
        response,
        pathname,
        { repositoryRoot }
      );
      let parsed: Record<string, unknown> | null = null;
      if (response.body) {
        try {
          parsed = JSON.parse(response.body) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      }
      return { status: response.statusCode, body: parsed };
    }
  };
}

interface CataloguePublication {
  readonly home: string;
  readonly state: string;
  readonly approvedDigest: string | null;
  readonly proposedDigest: string | null;
  readonly approvedPath: string;
}

function commandsServer(body: Record<string, unknown> | null): {
  readonly server: Record<string, unknown> | undefined;
} {
  const servers = (body?.servers as { name: string }[] | undefined) ?? [];
  return {
    server: servers.find((entry) => entry.name === "commands") as
      Record<string, unknown> | undefined
  };
}

function publications(
  body: Record<string, unknown> | null
): readonly CataloguePublication[] {
  const server = commandsServer(body).server;
  return (
    (server?.approvedCatalogues as CataloguePublication[] | undefined) ?? []
  );
}

test("the Commands backend publishes the approval state of each Runtime home", async () => {
  const h = harness({ approvedHomes: ["autodev"] });
  try {
    const response = await h.call("GET", "/control/mcps");
    assert.equal(response.status, 200);
    const states = publications(response.body).map((entry) => entry.state);
    // The AutoDev home holds the approved copy, and the checkout proposes the
    // same revision, so it is approved. The Codex home holds none, so the
    // backend there serves no catalogue at all.
    assert.deepEqual(states, ["approved", "unavailable"]);
    const autoDev = publications(response.body)[0];
    assert.equal(autoDev?.home, h.autodevHome);
    assert.equal(typeof autoDev?.approvedDigest, "string");
    assert.equal(autoDev?.approvedDigest, autoDev?.proposedDigest);
    assert.equal(
      autoDev?.approvedPath,
      join(h.autodevHome, "config", "commands.json")
    );
    const codex = publications(response.body)[1];
    assert.equal(codex?.home, h.codexHome);
    assert.equal(codex?.approvedDigest, null);
  } finally {
    h.restore();
  }
});

test("an installed catalogue that is not the checkout's proposal is pending approval", async () => {
  const h = harness({
    approvedHomes: ["autodev"],
    approvedContent: `${JSON.stringify(
      {
        ...CATALOGUE,
        commands: {
          ...CATALOGUE.commands,
          typecheck: {
            ...CATALOGUE.commands.typecheck,
            description: "An older approved revision."
          }
        }
      },
      null,
      2
    )}\n`
  });
  try {
    const response = await h.call("GET", "/control/mcps");
    assert.equal(response.status, 200);
    const autoDev = publications(response.body)[0];
    assert.equal(autoDev?.state, "pending");
    assert.notEqual(autoDev?.approvedDigest, autoDev?.proposedDigest);
  } finally {
    h.restore();
  }
});

test("a proposal that cannot be read is not observed, not pending", async () => {
  const h = harness({
    approvedHomes: ["autodev"],
    proposal: { version: 1, commands: { typecheck: { executable: "pnpm" } } }
  });
  try {
    const response = await h.call("GET", "/control/mcps");
    assert.equal(response.status, 200);
    const autoDev = publications(response.body)[0];
    // The proposal is not a valid catalogue, so the two revisions cannot be
    // compared: the installed copy is running, and whether it is the one the
    // checkout proposes is not known.
    assert.equal(autoDev?.state, "unknown");
    assert.equal(autoDev?.proposedDigest, null);
    assert.equal(typeof autoDev?.approvedDigest, "string");
  } finally {
    h.restore();
  }
});

test("a backend with no catalogued commands carries no approval publication", async () => {
  const h = harness({ approvedHomes: ["autodev"] });
  try {
    const response = await h.call("GET", "/control/mcps");
    assert.equal(response.status, 200);
    const servers =
      (response.body?.servers as
        { name: string; approvedCatalogues?: unknown }[] | undefined) ?? [];
    const other = servers.find((entry) => entry.name !== "commands");
    assert.ok(other, "the declared catalogue holds servers besides commands");
    assert.equal(other.approvedCatalogues, undefined);
  } finally {
    h.restore();
  }
});
