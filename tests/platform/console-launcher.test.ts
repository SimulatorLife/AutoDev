import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  launchAgentMatches,
  renderLaunchAgent
} from "@simulatorlife/autodev-runtime/platform/launchagent";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const plistPath = join(
  repositoryRoot,
  "config/launchagents/com.codex.autodev-console.plist"
);
const runScriptPath = join(repositoryRoot, "scripts/run-codex-console.sh");
const ensureScriptPath = join(
  repositoryRoot,
  "scripts/ensure-codex-console.sh"
);

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-console-test-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("console LaunchAgent plist matches label, loopback service requirements and placeholder contract", () => {
  const content = readFileSync(plistPath, "utf8");

  // Label requirement: com.codex.autodev-console
  assert.match(
    content,
    /<key>Label<\/key>\s*<string>com\.codex\.autodev-console<\/string>/u
  );

  // KeepAlive and RunAtLoad requirements
  assert.match(content, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(content, /<key>KeepAlive<\/key>\s*<true\/>/u);

  // ProgramArguments invokes hooks/run-codex-console.sh
  assert.match(
    content,
    /<string>__CODEX_HOME__\/hooks\/run-codex-console\.sh<\/string>/u
  );

  // Required placeholders in EnvironmentVariables
  const requiredPlaceholders = [
    ["AUTODEV_NODE_BIN", "__AUTODEV_NODE_BIN__"],
    ["CODEX_HOME", "__CODEX_HOME__"],
    ["HOME", "__HOME__"],
    ["AUTODEV_REPO_ROOT", "__AUTODEV_REPO_ROOT__"],
    ["AUTODEV_CONSOLE_PORT", "__AUTODEV_CONSOLE_PORT__"]
  ];
  for (const [key, placeholder] of requiredPlaceholders) {
    const pattern = new RegExp(
      String.raw`<key>${key}<\/key>\s*<string>${placeholder}<\/string>`,
      "u"
    );
    assert.match(
      content,
      pattern,
      `Expected plist to include placeholder for ${key}`
    );
  }

  // Stdout and stderr logs under CODEX_HOME/run
  assert.match(
    content,
    /<key>StandardOutPath<\/key>\s*<string>__CODEX_HOME__\/run\/[^<]+\.log<\/string>/u
  );
  assert.match(
    content,
    /<key>StandardErrorPath<\/key>\s*<string>__CODEX_HOME__\/run\/[^<]+\.log<\/string>/u
  );

  // Must NOT carry secret tokens or credentials in EnvironmentVariables or plist
  const envMatch = content.match(
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u
  );
  assert.ok(envMatch, "EnvironmentVariables block must exist in plist");
  const environmentVariables = envMatch[1];
  assert.ok(
    environmentVariables,
    "EnvironmentVariables block must not be empty"
  );
  assert.doesNotMatch(environmentVariables, /TOKEN|SECRET|KEY|PASSWORD/u);
  assert.doesNotMatch(content, /AUTODEV_CONTROL_API_TOKEN/u);
  assert.doesNotMatch(content, /AUTODEV_OPENLIT_USAGE_TOKEN/u);
  assert.doesNotMatch(content, /OPENLIT_DB_PASSWORD/u);
  assert.doesNotMatch(content, /OPENLIT_OTLP_API_KEY/u);

  // Must NOT run in Background tier (darwinbg throttles disk/CPU)
  assert.doesNotMatch(content, /<string>Background<\/string>/u);
});

test("console LaunchAgent rendering replaces all placeholders without interpolation drift", () =>
  withTempDir((directory) => {
    const target = join(directory, "com.codex.autodev-console.rendered.plist");
    const values = {
      codexHome: "/tmp/codex/$val",
      home: "/tmp/home&safe",
      repositoryRoot: String.raw`/tmp/autodev\repo`,
      nodeBin: "/opt/homebrew/bin/node",
      codexBin: "/opt/homebrew/bin/codex",
      consolePort: "4400"
    };

    renderLaunchAgent(plistPath, target, values);
    const rendered = readFileSync(target, "utf8");

    assert.ok(
      !rendered.includes("__CODEX_HOME__"),
      "__CODEX_HOME__ placeholder must be replaced"
    );
    assert.ok(
      !rendered.includes("__HOME__"),
      "__HOME__ placeholder must be replaced"
    );
    assert.ok(
      !rendered.includes("__AUTODEV_REPO_ROOT__"),
      "__AUTODEV_REPO_ROOT__ placeholder must be replaced"
    );
    assert.ok(
      !rendered.includes("__AUTODEV_NODE_BIN__"),
      "__AUTODEV_NODE_BIN__ placeholder must be replaced"
    );
    assert.ok(
      !rendered.includes("__AUTODEV_CONSOLE_PORT__"),
      "__AUTODEV_CONSOLE_PORT__ placeholder must be replaced"
    );
    // The LaunchAgent hands this value to `next start --port`. An unresolved
    // placeholder here is what crash-looped the console under KeepAlive.
    assert.match(
      rendered,
      /<key>AUTODEV_CONSOLE_PORT<\/key>\s*<string>4400<\/string>/u,
      "the console port must be rendered as the resolved value, not a template placeholder"
    );
    assert.equal(launchAgentMatches(plistPath, target, values), true);
  }));

test("console launcher rejects a non-numeric port before starting Next", () =>
  withTempDir((directory) => {
    const fakeRepo = join(directory, "repo");
    const codexHome = join(directory, "codex-home");
    const consoleDir = join(fakeRepo, "console");
    const fakeNode = join(directory, "fake-node");
    const marker = join(directory, "node-was-invoked");

    mkdirSync(join(consoleDir, ".next"), { recursive: true });
    mkdirSync(join(consoleDir, "node_modules/next/dist/bin"), {
      recursive: true
    });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(consoleDir, ".next/BUILD_ID"), "test-build-id-123\n");
    writeFileSync(
      join(consoleDir, "node_modules/next/dist/bin/next"),
      "#!/usr/bin/env bash\nexit 0\n",
      { mode: 0o755 }
    );
    writeFileSync(
      fakeNode,
      `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`,
      { mode: 0o755 }
    );

    const result = spawnSync("bash", [runScriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        CODEX_HOME: codexHome,
        AUTODEV_REPO_ROOT: fakeRepo,
        AUTODEV_NODE_BIN: fakeNode,
        // The exact value a mis-rendered plist shipped.
        AUTODEV_CONSOLE_PORT: "__AUTODEV_CONSOLE_PORT__"
      }
    });

    assert.notEqual(result.status, 0, "Launcher must refuse to start Next");
    assert.match(
      result.stderr,
      /AUTODEV_CONSOLE_PORT must be an integer/u,
      "Error must name the offending variable"
    );
    assert.match(
      result.stderr,
      /__AUTODEV_CONSOLE_PORT__/u,
      "Error must echo the rejected value so the bad render is visible"
    );
    assert.equal(
      existsSync(marker),
      false,
      "no Node process may run when the port is unusable"
    );
  }));

test("console launcher refuses to run and gives clear error if BUILD_ID is missing", () =>
  withTempDir((directory) => {
    const fakeRepo = join(directory, "repo");
    const consoleDir = join(fakeRepo, "console");
    mkdirSync(consoleDir, { recursive: true });

    const result = spawnSync("bash", [runScriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        AUTODEV_REPO_ROOT: fakeRepo,
        CODEX_HOME: join(directory, "codex")
      }
    });

    assert.notEqual(result.status, 0, "Launcher must exit with non-zero code");
    assert.match(
      result.stderr,
      /console\/\.next\/BUILD_ID is missing/,
      "Error must explicitly mention missing console/.next/BUILD_ID"
    );
    assert.match(
      result.stderr,
      /Runtime installer/i,
      "Error must clarify the installer pre-builds the console"
    );
  }));

test("console launcher adheres to loopback binding contract, exact-key tokens, and URL overrides", () =>
  withTempDir((directory) => {
    const fakeRepo = join(directory, "repo");
    const codexHome = join(directory, "codex-home");
    const consoleDir = join(fakeRepo, "console");
    const buildIdDir = join(consoleDir, ".next");
    const nextBinDir = join(consoleDir, "node_modules/next/dist/bin");
    const fakeNode = join(directory, "fake-node");
    const fakeNext = join(nextBinDir, "next");

    mkdirSync(buildIdDir, { recursive: true });
    mkdirSync(nextBinDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });

    // Touch BUILD_ID
    writeFileSync(join(buildIdDir, "BUILD_ID"), "test-build-id-123\n");
    // Touch next executable
    writeFileSync(fakeNext, "#!/usr/bin/env bash\necho next\n");
    chmodSync(fakeNext, 0o755);

    const controlToken = "c".repeat(64);
    const usageToken = "u".repeat(64);
    const dbPassword = "p".repeat(64);

    // openlit-secrets.env carries multiple secrets; only control & usage tokens must be parsed
    writeFileSync(
      join(codexHome, "openlit-secrets.env"),
      [
        `OPENLIT_DB_PASSWORD=${dbPassword}`,
        `AUTODEV_CONTROL_API_TOKEN=${controlToken}`,
        `OPENLIT_OTLP_API_KEY=${"k".repeat(64)}`,
        `AUTODEV_OPENLIT_USAGE_TOKEN=${usageToken}`
      ].join("\n") + "\n",
      { mode: 0o600 }
    );

    // .env carries nonsecret URL overrides and a rogue token that must be ignored
    writeFileSync(
      join(codexHome, ".env"),
      [
        "AUTODEV_CONTROL_API_BASE_URL=http://127.0.0.1:4101",
        "AUTODEV_OPENLIT_USAGE_URL=http://127.0.0.1:3000",
        // Retired with the external Memory bridge: the Console no longer reads
        // this variable, so the launcher must not forward it either.
        "AUTODEV_OPENLIT_UI_URL=http://127.0.0.1:3000",
        "AUTODEV_CONTROL_API_TOKEN=rogue-token-from-env-must-be-ignored",
        "SECRET_ENV_VAR=should-not-be-exported"
      ].join("\n") + "\n"
    );

    // Fake Node binary records passed arguments and exported environment variables
    writeFileSync(
      fakeNode,
      [
        "#!/usr/bin/env bash",
        'echo "ARGS:$*"',
        'echo "TOKEN_CONTROL:${AUTODEV_CONTROL_API_TOKEN:-}"',
        'echo "TOKEN_USAGE:${AUTODEV_OPENLIT_USAGE_TOKEN:-}"',
        'echo "URL_CONTROL:${AUTODEV_CONTROL_API_BASE_URL:-}"',
        'echo "URL_USAGE:${AUTODEV_OPENLIT_USAGE_URL:-}"',
        'echo "URL_UI:${AUTODEV_OPENLIT_UI_URL:-}"',
        'echo "SECRET_DB:${OPENLIT_DB_PASSWORD:-}"',
        'echo "SECRET_ENV:${SECRET_ENV_VAR:-}"',
        'echo "CONSOLE_PORT:${AUTODEV_CONSOLE_PORT:-}"',
        'echo "PWD:$(pwd)"',
        "exit 0"
      ].join("\n")
    );
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [runScriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        CODEX_HOME: codexHome,
        AUTODEV_REPO_ROOT: fakeRepo,
        AUTODEV_NODE_BIN: fakeNode,
        AUTODEV_CONSOLE_PORT: "3300",
        // Test inherited tokens in parent environment get reset
        AUTODEV_CONTROL_API_TOKEN: "stale-parent-token"
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const lines = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const colonIdx = line.indexOf(":");
          return colonIdx === -1
            ? [line, ""]
            : [line.slice(0, colonIdx), line.slice(colonIdx + 1)];
        })
    );

    const controlPreflightIndex = result.stdout.indexOf(
      "verify-control-api.ts"
    );
    const usagePreflightIndex = result.stdout.indexOf(
      "platform/usage-contract.ts"
    );
    const nextStartIndex = result.stdout.indexOf("next start --hostname");
    assert.ok(controlPreflightIndex !== -1, "Control API preflight must run");
    assert.ok(
      usagePreflightIndex > controlPreflightIndex,
      "Usage preflight follows Control API validation"
    );
    assert.ok(
      nextStartIndex > usagePreflightIndex,
      "Next starts only after both backends validate"
    );

    // Verify next binary invocation arguments: must bind to loopback 127.0.0.1 and port 3300
    const args = lines.ARGS;
    assert.ok(args, "fake Node process must report the launched arguments");
    assert.match(
      args,
      /next start --hostname 127\.0\.0\.1 --port 3300/,
      "Must exec next start with --hostname 127.0.0.1 --port 3300"
    );

    // `next start` resolves its project dir from the working directory, and the
    // LaunchAgent declares no WorkingDirectory, so launchd starts the script
    // at `/`. Next must therefore be exec'd from the console directory whose
    // `.next` the launcher just gated on, or it reports no production build.
    assert.equal(
      lines.PWD,
      consoleDir,
      "Next must be exec'd from the console directory that holds the production build"
    );

    // Verify token values came from openlit-secrets.env (not .env or inherited)
    assert.equal(
      lines.TOKEN_CONTROL,
      controlToken,
      "AUTODEV_CONTROL_API_TOKEN must match value from openlit-secrets.env"
    );
    assert.equal(
      lines.TOKEN_USAGE,
      usageToken,
      "AUTODEV_OPENLIT_USAGE_TOKEN must match value from openlit-secrets.env"
    );

    // Verify other secrets from openlit-secrets.env were NOT exported
    assert.equal(
      lines.SECRET_DB,
      "",
      "OPENLIT_DB_PASSWORD must not be exported by console launcher"
    );

    // Verify URL overrides from .env were exported
    assert.equal(lines.URL_CONTROL, "http://127.0.0.1:4101");
    assert.equal(lines.URL_USAGE, "http://127.0.0.1:3000");
    assert.equal(
      lines.URL_UI,
      "",
      "the retired external Memory bridge URL must not be forwarded"
    );

    // Verify non-URL variables from .env were NOT exported
    assert.equal(
      lines.SECRET_ENV,
      "",
      "Non-URL variables from .env must not be exported"
    );

    // Verify launcher output does NOT print token values
    assert.ok(
      !result.stderr.includes(controlToken),
      "Launcher stderr must never echo control token"
    );
    assert.ok(
      !result.stderr.includes(usageToken),
      "Launcher stderr must never echo usage token"
    );
  }));

test("console launcher reports a backend that did not answer as a temporary failure", () =>
  withTempDir((directory) => {
    const fakeRepo = join(directory, "repo");
    const codexHome = join(directory, "codex-home");
    const consoleDir = join(fakeRepo, "console");
    const buildIdDir = join(consoleDir, ".next");
    const nextBinDir = join(consoleDir, "node_modules/next/dist/bin");
    const fakeNode = join(directory, "fake-node");
    const fakeNext = join(nextBinDir, "next");

    mkdirSync(buildIdDir, { recursive: true });
    mkdirSync(nextBinDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(buildIdDir, "BUILD_ID"), "test-build-id-123\n");
    writeFileSync(fakeNext, "#!/usr/bin/env bash\necho next\n");
    chmodSync(fakeNext, 0o755);
    writeFileSync(
      join(codexHome, "openlit-secrets.env"),
      [
        `AUTODEV_CONTROL_API_TOKEN=${"c".repeat(64)}`,
        `AUTODEV_OPENLIT_USAGE_TOKEN=${"u".repeat(64)}`
      ].join("\n") + "\n",
      { mode: 0o600 }
    );

    // The preflight reports that a backend did not answer: EX_TEMPFAIL.
    writeFileSync(
      fakeNode,
      [
        "#!/usr/bin/env bash",
        'echo "ARGS:$*"',
        'case "$*" in',
        "  *verify-control-api.ts*) exit 75 ;;",
        "esac",
        "exit 0"
      ].join("\n")
    );
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [runScriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        CODEX_HOME: codexHome,
        AUTODEV_REPO_ROOT: fakeRepo,
        AUTODEV_NODE_BIN: fakeNode,
        AUTODEV_CONSOLE_PORT: "3300"
      }
    });

    assert.equal(
      result.status,
      75,
      "a backend that did not answer is a temporary failure, not a broken service"
    );
    assert.doesNotMatch(
      result.stdout,
      /next start/u,
      "the Console must not serve against a backend that did not answer"
    );
    assert.match(result.stderr, /a backend did not answer/u);
  }));

test("console ensure script resolves node and dispatches to console-ensure module", () =>
  withTempDir((directory) => {
    const fakeNode = join(directory, "fake-node");
    const fakeModule = join(directory, "fake-console-ensure.ts");

    writeFileSync(fakeModule, "// fake console-ensure module\n");
    writeFileSync(
      fakeNode,
      ["#!/usr/bin/env bash", 'echo "ENSURE_DISPATCH:$1"', "exit 0"].join("\n")
    );
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [ensureScriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        AUTODEV_NODE_BIN: fakeNode,
        AUTODEV_CONSOLE_ENSURE_MODULE: fakeModule
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`ENSURE_DISPATCH:${fakeModule}`, "u"),
      "ensure script must dispatch to the typed console-ensure module"
    );
  }));

test("console /api/health route responds with process-liveness contract and no backend-readiness claim", async () => {
  const route = await import("../../console/app/api/health/route.ts");

  assert.equal(typeof route.GET, "function", "GET handler must be exported");

  const response = route.GET();
  assert.equal(response.status, 200, "Must return HTTP 200 status");
  assert.equal(
    response.headers.get("Cache-Control"),
    "no-store",
    "Must set Cache-Control: no-store"
  );
  assert.match(
    response.headers.get("Content-Type") ?? "",
    /application\/json/i,
    "Must set Content-Type: application/json"
  );

  const payload = await response.json();

  // Validate exact schema contract
  assert.equal(payload.schema, "autodev-console-health-v1");
  assert.equal(payload.status, "alive");
  assert.equal(payload.service, "autodev-console");
  assert.equal(typeof payload.pid, "number");
  assert.equal(payload.pid, process.pid);
  assert.equal(typeof payload.nodeVersion, "string");
  assert.equal(payload.nodeVersion, process.version);
  assert.equal(typeof payload.port, "number");
  assert.equal(payload.port, 3300);
  assert.equal(typeof payload.timestamp, "string");
  assert.ok(!Number.isNaN(Date.parse(payload.timestamp)));

  // Contract: must NOT include backend readiness or leaked tokens
  assert.equal("backendReady" in payload, false);
  assert.equal("controlApiStatus" in payload, false);
  assert.equal("openlitStatus" in payload, false);
  assert.equal("token" in payload, false);
});
