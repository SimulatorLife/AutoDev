import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LAUNCH_LABELS } from "../../src/platform/install-materializer.ts";
import {
  launchAgentMatches,
  renderLaunchAgent
} from "../../src/platform/macos/launchagent.ts";

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
      nodeBin: "/tmp/node$&/bin/node"
    };
    writeFileSync(
      template,
      "<string>__CODEX_HOME__</string>\n<string>__HOME__</string>\n<string>__AUTODEV_REPO_ROOT__</string>\n<string>__AUTODEV_NODE_BIN__</string>\n"
    );
    renderLaunchAgent(template, target, values);
    assert.equal(
      readFileSync(target, "utf8"),
      "<string>/tmp/codex/$value</string>\n<string>/tmp/home&safe</string>\n<string>/tmp/repo\\path</string>\n<string>/tmp/node$&/bin/node</string>\n"
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
      nodeBin: "/node"
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
