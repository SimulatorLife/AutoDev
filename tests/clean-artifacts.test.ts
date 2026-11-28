import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("clean removes disposable build artifacts without deleting live CocoIndex state", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-clean-"));
  const bin = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const preserved = [
    ".cocoindex_code/settings.yml",
    ".cocoindex_code/target_sqlite.db",
    ".cocoindex_code/cocoindex.db/state",
    ".cocoindex_code/.tmp/.eslintcache",
    "nested/.cocoindex_code/settings.yml",
    ".git/tmp/metadata"
  ];
  const removed = [
    "console/.next/file",
    "runtime/node_modules/dependency",
    "runtime/tmp/file",
    ".tmp/file",
    "nested/cache.tsbuildinfo",
    "nested/.eslintcache"
  ];
  try {
    mkdirSync(bin);
    mkdirSync(workspace);
    writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700
    });
    for (const relative of [...preserved, ...removed]) {
      const file = path.join(workspace, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, relative);
    }
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts: { clean: string } };
    const result = spawnSync("/bin/sh", ["-c", manifest.scripts.clean], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
          path.delimiter
        )
      },
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(result.status, 0, result.stderr);
    for (const relative of preserved)
      assert.equal(readFileSync(path.join(workspace, relative), "utf8"), relative);
    for (const relative of removed)
      assert.equal(existsSync(path.join(workspace, relative)), false, relative);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
