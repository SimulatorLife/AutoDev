import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";

test("isEntryPoint matches direct, symlinked, sibling, and relative entry paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-entry-point-"));
  try {
    const generationDir = path.join(root, ".src-abc123", "router");
    const symlinkRoot = path.join(root, "src");
    mkdirSync(generationDir, { recursive: true });
    const serverFile = path.join(generationDir, "server.ts");
    const helperFile = path.join(generationDir, "http.ts");
    writeFileSync(serverFile, "export {};\n");
    writeFileSync(helperFile, "export {};\n");
    symlinkSync(".src-abc123", symlinkRoot);

    const symlinkedEntry = path.join(symlinkRoot, "router", "server.ts");
    const moduleUrl = pathToFileURL(serverFile).href;
    const siblingModuleUrl = new URL("server.ts", pathToFileURL(helperFile));

    assert.equal(isEntryPoint(moduleUrl, serverFile), true);
    assert.equal(isEntryPoint(moduleUrl, symlinkedEntry), true);
    assert.equal(isEntryPoint(siblingModuleUrl, symlinkedEntry), true);
    assert.equal(
      isEntryPoint(moduleUrl, path.relative(process.cwd(), symlinkedEntry)),
      true
    );
    assert.equal(isEntryPoint(moduleUrl, helperFile), false);
    assert.equal(isEntryPoint(moduleUrl, undefined), false);
    assert.equal(isEntryPoint(moduleUrl, ""), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
