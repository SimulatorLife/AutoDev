import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const trackedFiles = execFileSync(
  "git",
  ["ls-files", "-co", "--exclude-standard", "-z"],
  {
    cwd: root,
    encoding: "utf8"
  }
)
  .split("\0")
  .filter(Boolean)
  .filter((file) =>
    existsSync(join(new URL("../../", import.meta.url).pathname, file))
  );

const approvedLegacyFiles = new Set([
  ".rulesync/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py",
  "scripts/bootstrap-repo-exclusions.sh",
  "scripts/enforce-root-delegation.sh",
  "scripts/ensure-codex-antigravity-proxy.sh",
  "scripts/ensure-codex-claude-bridge.sh",
  "scripts/ensure-codex-copilot-proxy.sh",
  "scripts/ensure-codex-minimax-proxy.sh",
  "scripts/ensure-codex-model-router.sh",
  "scripts/install.sh",
  "scripts/run-autodev-mcp.sh",
  "scripts/run-ci-provider.sh",
  "scripts/run-codex-antigravity-proxy.sh",
  "scripts/run-codex-claude-bridge.sh",
  "scripts/run-codex-copilot-cli-responses-proxy.sh",
  "scripts/run-codex-model-router.sh",
  "scripts/run-provider-agent.sh",
  "config/openlit/assets/clickhouse-init.sh",
  "eslint.config.js",
  "scripts/openlit/apply-patches.sh",
  "scripts/openlit/bootstrap-otlp-key.sh",
  "scripts/openlit/bootstrap-secrets.sh",
  "scripts/openlit/build-local.sh",
  "scripts/openlit/down.sh",
  "scripts/openlit/pin-image.sh",
  "scripts/openlit/up.sh"
]);

const forbiddenImplementationFiles = trackedFiles.filter((file) => {
  if (approvedLegacyFiles.has(file)) return false;
  return /\.(?:c?js|mjs|py|sh)$/u.test(file);
});

test(
  "first-party implementation inventory uses native TypeScript",
  { skip: process.env.AUTODEV_ENFORCE_INVENTORY !== "1" },
  () => {
    assert.deepEqual(
      forbiddenImplementationFiles,
      [],
      `legacy implementation files remain:\n${forbiddenImplementationFiles.join("\n")}`
    );
  }
);

test("approved non-TypeScript files remain explicit and bounded", () => {
  assert.deepEqual(
    trackedFiles
      .filter(
        (file) =>
          /\.(?:c?js|mjs|py|sh)$/u.test(file) && approvedLegacyFiles.has(file)
      )
      .sort(),
    [...approvedLegacyFiles].sort()
  );
});

test("AutoDev standalone OTel Collector sidecar files are not re-tracked", () => {
  // The AutoDev-owned standalone Collector must not return as a replacement
  // sidecar. No replacement file is allowed in any of these locations.
  const removedAutoDevFiles = [
    "runtime/src/platform/otel-collector.ts",
    "runtime/src/platform/otel-provision.ts",
    "config/otel/collector.yaml",
    "config/otel/collector.version",
    "config/otel/collector-artifacts.json",
    "scripts/otel/ensure-autodev-otel-collector.sh",
    "scripts/otel/provision-autodev-otel-collector.sh",
    "scripts/otel/run-autodev-otel-collector.sh",
    "config/launchagents/com.codex.otel-collector.plist"
  ];
  const trackedSet = new Set(trackedFiles);
  for (const filePath of removedAutoDevFiles) {
    assert.equal(
      trackedSet.has(filePath),
      false,
      `${filePath} must not be re-tracked as a replacement sidecar source`
    );
    assert.equal(
      approvedLegacyFiles.has(filePath),
      false,
      `${filePath} must not be re-approved as a legacy Collector source`
    );
  }
  // No replacement scripts/otel/ or config/otel/ sidecar may be added under
  // those prefixes either.
  for (const file of trackedFiles) {
    assert.equal(
      file.startsWith("scripts/otel/"),
      false,
      `${file} must not be re-tracked under scripts/otel/ as a replacement sidecar`
    );
    assert.equal(
      file.startsWith("config/otel/"),
      false,
      `${file} must not be re-tracked under config/otel/ as a replacement sidecar`
    );
  }
});
