import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  opencliBrowserSettingFile,
  readOpencliDedicatedBrowser,
  writeOpencliDedicatedBrowser
} from "@simulatorlife/autodev-runtime/shared/opencli-browser-setting";

test("the opencli browser setting lives in CODEX_HOME's run state unless a file is named", () => {
  assert.equal(
    opencliBrowserSettingFile({ CODEX_HOME: "/codex" }),
    "/codex/run/opencli-browser.json"
  );
  assert.equal(
    opencliBrowserSettingFile({
      CODEX_HOME: "/codex",
      OPENCLI_BROWSER_SETTING_FILE: "/elsewhere/setting.json"
    }),
    "/elsewhere/setting.json"
  );
});

test("the operator's own Chrome is the default, and only a written setting turns the dedicated browser on", () => {
  const root = mkdtempSync(join(tmpdir(), "opencli-browser-setting-"));
  const file = join(root, "run", "opencli-browser.json");
  try {
    assert.equal(readOpencliDedicatedBrowser(file), false, "missing file");
    writeOpencliDedicatedBrowser(file, true);
    assert.equal(readOpencliDedicatedBrowser(file), true);
    writeOpencliDedicatedBrowser(file, false);
    assert.equal(readOpencliDedicatedBrowser(file), false);
    for (const malformed of [
      "{",
      JSON.stringify({ dedicated: true }),
      JSON.stringify({ schema: "autodev-opencli-browser-v1", dedicated: "yes" })
    ]) {
      writeFileSync(file, malformed);
      assert.equal(readOpencliDedicatedBrowser(file), false, malformed);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
