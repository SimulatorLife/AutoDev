import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import test from "node:test";

import {
  CODEX_TOOLS_TURN_ENV,
  codexToolsMcpServer
} from "@simulatorlife/autodev-runtime/mcp/codex-tools-shim";
import {
  agyArgs,
  createIsolatedAntigravityHome
} from "@simulatorlife/autodev-runtime/providers/antigravity";

const REPO_ROOT = pathResolve(import.meta.dirname, "..");
const ROLE = "orchestrator";

/**
 * The smallest Antigravity home an invocation can be built from: the user state
 * agy signs in from, and a provider-runtime catalogue holding exactly the
 * servers the orchestrator role is granted.
 */
function fixtureEnvironment(): {
  codexHome: string;
  userHome: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "autodev-agy-codex-tools-"));
  const codexHome = join(root, "codex");
  const userHome = join(root, "user-home");

  const runtimeDir = join(codexHome, "provider-runtime");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const bridgeServer = (script: string) => ({
    command: "bash",
    args: ["-lc", `exec run-autodev-mcp.sh ${script}`]
  });
  writeFileSync(
    join(runtimeDir, "mcp-servers.json"),
    JSON.stringify({
      lsp: bridgeServer("lsp"),
      "cocoindex-code": bridgeServer("cocoindex-code"),
      codegraphcontext: bridgeServer("codegraphcontext"),
      codex_app: { command: "node", args: ["./server.mjs"] }
    }),
    { mode: 0o600 }
  );

  const gemini = join(userHome, ".gemini");
  const configDir = join(gemini, "config");
  const cliDir = join(gemini, "antigravity-cli");
  const browserProfile = join(gemini, "antigravity-browser-profile");
  for (const dir of [configDir, cliDir, browserProfile]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    join(configDir, "mcp_config.json"),
    JSON.stringify({ mcpServers: {} }),
    { mode: 0o600 }
  );
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ auth: "user-token" }),
    { mode: 0o600 }
  );
  writeFileSync(
    join(cliDir, "settings.json"),
    JSON.stringify({ permissions: { allow: [], deny: [] } }),
    { mode: 0o600 }
  );
  writeFileSync(join(cliDir, "antigravity-oauth-token"), "mock", {
    mode: 0o600
  });
  writeFileSync(join(browserProfile, "profile.dat"), "mock", { mode: 0o600 });

  return {
    codexHome,
    userHome,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function isolatedServers(
  toolTurnId: string | null
): Record<string, Record<string, unknown>> {
  const env = fixtureEnvironment();
  try {
    const isolated = createIsolatedAntigravityHome(ROLE, "session-shim", {
      originalHome: env.userHome,
      codexHome: env.codexHome,
      cwd: REPO_ROOT,
      toolTurnId
    });
    try {
      return isolated.mcpConfig.mcpServers as Record<
        string,
        Record<string, unknown>
      >;
    } finally {
      isolated.cleanup();
    }
  } finally {
    env.cleanup();
  }
}

test("a turn that can park a call is given the tools shim, naming that turn", () => {
  const servers = isolatedServers("turn-shim-test");
  const server = servers.codex;
  assert.ok(
    server,
    "a turn holding a Codex tool turn id must be offered Codex's tools"
  );
  // The launch definition is the one the shim's own module produces, so this
  // asserts agy is handed a working server rather than a lookalike carrying the
  // right key and the wrong bridge.
  assert.deepEqual(
    server,
    codexToolsMcpServer("turn-shim-test", {
      url: `http://${process.env.ANTIGRAVITY_BRIDGE_HOST ?? "127.0.0.1"}:${process.env.ANTIGRAVITY_BRIDGE_PORT ?? "4002"}`,
      token: process.env.LITELLM_API_KEY ?? ""
    })
  );
  assert.equal(
    (server.env as Record<string, string>)[CODEX_TOOLS_TURN_ENV],
    "turn-shim-test"
  );
});

test("a turn that cannot park a call is not given the tools shim", () => {
  assert.equal(
    isolatedServers(null).codex,
    undefined,
    "a non-streaming turn has nowhere to continue a parked call, so it must not launch a shim"
  );
});

test("the invocation's own agent runs with Codex's tools and nothing else", () => {
  const env = fixtureEnvironment();
  try {
    const isolated = createIsolatedAntigravityHome(ROLE, "session-shim", {
      originalHome: env.userHome,
      codexHome: env.codexHome,
      cwd: REPO_ROOT,
      toolTurnId: "turn-shim-test"
    });
    try {
      const dir = isolated.customizationDir;
      assert.ok(dir, "a turn with the shim must be given its agent definition");
      assert.equal(
        dir.startsWith(isolated.isolatedHome),
        true,
        "the definitions belong to this invocation, not to the user's workspace"
      );
      assert.equal(dir.startsWith(REPO_ROOT), false);

      const definition = readFileSync(
        join(dir, ".agents", "agents", "autodev-codex-tools", "agent.md"),
        "utf8"
      );
      assert.match(
        definition,
        /^excludeDefaultComponents: true$/m,
        "built-ins must leave the tool set or the shim is never reached for"
      );
      assert.match(definition, /^name: autodev-codex-tools$/m);

      const args = agyArgs("prompt", "model", "high", ROLE, null, {
        agentName: "autodev-codex-tools",
        customizationDir: dir
      });
      assert.deepEqual(
        args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 4),
        ["--add-dir", dir, "--agent", "autodev-codex-tools"]
      );
      // agy takes the token after -p as the prompt, so a flag sitting between
      // them becomes the prompt text and the real prompt is ignored.
      assert.equal(
        args[args.indexOf("-p") + 1],
        "prompt",
        "-p must be followed immediately by the prompt"
      );
      assert.ok(
        args.indexOf("--agent") > args.indexOf("-p"),
        "the agent flag must come after the prompt"
      );
    } finally {
      isolated.cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test("a turn without the shim is not run as the Codex-tools agent", () => {
  const env = fixtureEnvironment();
  try {
    const isolated = createIsolatedAntigravityHome(ROLE, "session-shim", {
      originalHome: env.userHome,
      codexHome: env.codexHome,
      cwd: REPO_ROOT,
      toolTurnId: null
    });
    try {
      assert.equal(
        isolated.customizationDir,
        null,
        "an agent with no tools behind it leaves the model unable to act"
      );
      assert.ok(
        !agyArgs("prompt", "model", "high", ROLE, null, null).includes(
          "--agent"
        )
      );
    } finally {
      isolated.cleanup();
    }
  } finally {
    env.cleanup();
  }
});
