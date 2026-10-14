import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LAUNCH_LABELS } from "@simulatorlife/autodev-runtime/platform/install-materializer";
import {
  launchAgentMatches,
  renderLaunchAgent,
  resolveLaunchAgentValues
} from "@simulatorlife/autodev-runtime/platform/launchagent";

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-launchagent-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("launchagent rendering replaces placeholders without replacement-string interpolation", () =>
  withTempDir((directory) => {
    const template = join(directory, "template.plist");
    const target = join(directory, "nested", "service.plist");
    const values = {
      codexHome: "/tmp/codex/$value",
      home: "/tmp/home&safe",
      repositoryRoot: String.raw`/tmp/repo\path`,
      nodeBin: "/tmp/node$&/bin/node",
      consolePort: "3300"
    };
    writeFileSync(
      template,
      "<string>__CODEX_HOME__</string>\n<string>__HOME__</string>\n<string>__AUTODEV_REPO_ROOT__</string>\n<string>__AUTODEV_NODE_BIN__</string>\n<string>__AUTODEV_CONSOLE_PORT__</string>\n"
    );
    renderLaunchAgent(template, target, values);
    assert.equal(
      readFileSync(target, "utf8"),
      "<string>/tmp/codex/$value</string>\n<string>/tmp/home&safe</string>\n<string>/tmp/repo\\path</string>\n<string>/tmp/node$&/bin/node</string>\n<string>3300</string>\n"
    );
    assert.equal(launchAgentMatches(template, target, values), true);
  }));

test("launchagent drift check detects changed rendered output", () =>
  withTempDir((directory) => {
    const template = join(directory, "template.plist");
    const target = join(directory, "service.plist");
    writeFileSync(template, "__CODEX_HOME__");
    const values = {
      codexHome: "/codex",
      home: "/home",
      repositoryRoot: "/repo",
      nodeBin: "/node",
      consolePort: "3300"
    };
    renderLaunchAgent(template, target, values);
    writeFileSync(target, "drift");
    assert.equal(launchAgentMatches(template, target, values), false);
  }));

test("every service LaunchAgent pins the installer's Node for its launcher", () => {
  for (const label of LAUNCH_LABELS) {
    const template = readFileSync(
      new URL(`../../config/launchagents/${label}.plist`, import.meta.url),
      "utf8"
    );
    assert.match(
      template,
      /<key>AUTODEV_NODE_BIN<\/key>\s*<string>__AUTODEV_NODE_BIN__<\/string>/u,
      `${label}: launchd's PATH would otherwise pick /usr/local/bin/node`
    );
    assert.doesNotMatch(
      template,
      /<string>Background<\/string>/u,
      `${label}: Background puts the service in the throttled darwinbg tier`
    );
  }
});

test("model router LaunchAgent resolves canonical configuration from the checkout", () => {
  const template = readFileSync(
    new URL(
      "../../config/launchagents/com.codex.model-router.plist",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(
    template,
    /<key>AUTODEV_REPO_ROOT<\/key>\s*<string>__AUTODEV_REPO_ROOT__<\/string>/u
  );
});

const RENDERED_VALUES = {
  codexHome: "/codex",
  home: "/home",
  repositoryRoot: "/repo",
  nodeBin: "/node",
  consolePort: "3300"
};

test("every shipped LaunchAgent template renders with no unresolved placeholder", () =>
  withTempDir((directory) => {
    for (const label of LAUNCH_LABELS) {
      const template = new URL(
        `../../config/launchagents/${label}.plist`,
        import.meta.url
      ).pathname;
      const target = join(directory, `${label}.plist`);
      // renderLaunchAgent throws on an unresolved placeholder, so reaching the
      // drift assertion already proves the rendered file is launchd-ready.
      renderLaunchAgent(template, target, RENDERED_VALUES);
      assert.doesNotMatch(
        readFileSync(target, "utf8"),
        /__[A-Z0-9_]+__/u,
        `${label}: rendered plist must carry no unsubstituted placeholder`
      );
      assert.equal(launchAgentMatches(template, target, RENDERED_VALUES), true);
    }
  }));

test("the unresolved-placeholder guard fires and names the placeholder", () =>
  withTempDir((directory) => {
    const template = join(directory, "template.plist");
    const target = join(directory, "service.plist");
    writeFileSync(
      template,
      "<string>__CODEX_HOME__</string>\n<string>__UNKNOWN__</string>\n"
    );

    assert.throws(
      () => renderLaunchAgent(template, target, RENDERED_VALUES),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("__UNKNOWN__") &&
        error.message.includes(template),
      "an unrendered placeholder must fail the render and name both the placeholder and its template"
    );
    assert.equal(
      existsSync(target),
      false,
      "a refused render must not leave a partial plist for launchd to load"
    );
    // The drift gate cannot certify a file it could not fully resolve, so it
    // reports drift and asks for a re-render instead of passing.
    assert.equal(launchAgentMatches(template, target, RENDERED_VALUES), false);
  }));

test("resolveLaunchAgentValues derives the console port the installer renders", () =>
  withTempDir((directory) => {
    const paths = {
      repositoryRoot: "/repo",
      home: directory,
      codexHome: "/codex"
    };
    assert.equal(
      resolveLaunchAgentValues(paths, { AUTODEV_CONSOLE_PORT: "4400" })
        .consolePort,
      "4400"
    );
    assert.equal(
      resolveLaunchAgentValues(paths, {}).consolePort,
      "3300",
      "an unset port must render the documented default, not a placeholder"
    );
    assert.throws(
      () =>
        resolveLaunchAgentValues(paths, { AUTODEV_CONSOLE_PORT: "not-a-port" }),
      /AUTODEV_CONSOLE_PORT must be an integer/u,
      "a bad override must fail at install time rather than reach launchd"
    );
  }));
