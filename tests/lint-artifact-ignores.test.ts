import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("ESLint ignores generated probe, scratch, and staged Next artifacts", async () => {
  const suffix = String(process.pid);
  const directories = [
    path.join(repositoryRoot, ".probe", `lint-check-${suffix}`),
    path.join(repositoryRoot, `.scratch-lint-${suffix}`),
    path.join(repositoryRoot, "console", `.next-staging-${suffix}`)
  ];
  const sources = directories.map((directory) => {
    mkdirSync(directory, { recursive: true });
    const source = path.join(directory, "ignored.ts");
    writeFileSync(source, "console.log('generated artifact');\n");
    return source;
  });

  try {
    const eslint = new ESLint({ cwd: repositoryRoot });
    for (const source of sources) {
      assert.equal(await eslint.isPathIgnored(source), true, source);
    }
  } finally {
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
