import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../scripts/setup-codex-cloud.sh", import.meta.url)
);

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-codex-cloud-"));
  const bin = path.join(root, "bin");
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(bin);
  copyFileSync(source, path.join(root, "scripts/setup-codex-cloud.sh"));
  writeFileSync(path.join(root, ".nvmrc"), "24.12\n");
  writeFileSync(
    path.join(root, "package.json"),
    '{"packageManager":"pnpm@10.32.1"}\n'
  );
  writeFileSync(
    path.join(bin, "node"),
    '#!/bin/sh\ncase "$1" in\n  -) exit "${MOCK_NODE_STATUS:-0}" ;;\n  -p) printf "10.32.1\\n" ;;\n  *) exit 1 ;;\nesac\n',
    { mode: 0o755 }
  );
  writeFileSync(
    path.join(bin, "pnpm"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf "%s\\n" "${MOCK_PNPM_VERSION:-10.32.1}"\nelse\n  printf "pnpm %s\\n" "$*" >> "$CALLS"\nfi\n',
    { mode: 0o755 }
  );
  writeFileSync(
    path.join(bin, "corepack"),
    '#!/bin/sh\nprintf "corepack %s\\n" "$*" >> "$CALLS"\n',
    { mode: 0o755 }
  );
  writeFileSync(
    path.join(bin, "bash"),
    '#!/bin/sh\nprintf "bash %s\\n" "$*" >> "$CALLS"\n',
    { mode: 0o755 }
  );
  const calls = path.join(root, "calls");
  const run = (overrides: Record<string, string> = {}) =>
    spawnSync("/bin/bash", [path.join(root, "scripts/setup-codex-cloud.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ...overrides,
        PATH: `${bin}:${process.env.PATH}`,
        CALLS: calls
      }
    });
  const commands = () => readFileSync(calls, "utf8").trim().split("\n");
  return { root, run, commands };
}

test("cloud setup installs the pinned workspace and generates Codex skills", (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.commands(), [
    "corepack enable",
    "pnpm install --frozen-lockfile",
    "bash scripts/bootstrap-repo-exclusions.sh",
    "pnpm exec rulesync generate --targets codexcli --features skills --silent",
    "pnpm autodev -- --help"
  ]);
});

test("cloud setup rejects an unsupported Node version before installing", (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = fixture.run({ MOCK_NODE_STATUS: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires Node 24\.12\+/);
});

test("cloud setup rejects pnpm version drift before installing", (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = fixture.run({ MOCK_PNPM_VERSION: "10.31.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected pnpm 10\.32\.1, found 10\.31\.0/);
  assert.deepEqual(fixture.commands(), ["corepack enable"]);
});
