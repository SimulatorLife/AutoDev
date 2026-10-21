import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { renderRuntimeMirrorPackage } from "@simulatorlife/autodev-runtime/platform/runtime-mirror-package";

const RUNTIME_PACKAGE = {
  name: "@simulatorlife/autodev-runtime",
  type: "module",
  exports: {
    ".": "./src/index.ts",
    "./router/routing": "./src/router/routing.ts",
    "./shared/output": "./src/shared/output.ts"
  }
};

test("the installed manifest keeps the package name and rewrites export targets", () => {
  const manifest = JSON.parse(
    renderRuntimeMirrorPackage({
      runtimePackage: RUNTIME_PACKAGE,
      materialized: new Set([
        "runtime/src/index.ts",
        "runtime/src/router/routing.ts",
        "runtime/src/shared/output.ts"
      ])
    })
  ) as { name: string; type: string; exports: Record<string, string> };

  assert.equal(manifest.name, "@simulatorlife/autodev-runtime");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.exports["./router/routing"], "./router/routing.ts");
  assert.equal(manifest.exports["./shared/output"], "./shared/output.ts");
  assert.equal(manifest.exports["."], "./index.ts");
});

test("the installed manifest exports only the subpaths the installed tree owns", () => {
  const manifest = JSON.parse(
    renderRuntimeMirrorPackage({
      runtimePackage: RUNTIME_PACKAGE,
      materialized: new Set(["runtime/src/router/routing.ts"])
    })
  ) as { exports: Record<string, string> };

  assert.deepEqual(manifest.exports, {
    "./router/routing": "./router/routing.ts"
  });
});

test("the installed manifest rejects an export target outside the Runtime source tree", () => {
  assert.throws(
    () =>
      renderRuntimeMirrorPackage({
        runtimePackage: {
          name: "@simulatorlife/autodev-runtime",
          exports: { "./package.json": "./package.json" }
        },
        materialized: new Set<string>()
      }),
    /runtime-package-export-outside-source/
  );
});

test("the installed manifest rejects a package manifest without a name", () => {
  assert.throws(
    () =>
      renderRuntimeMirrorPackage({
        runtimePackage: { exports: {} },
        materialized: new Set<string>()
      }),
    /runtime-package-manifest-missing-name/
  );
});

/**
 * The failure this guards: the installed tree imported a Runtime module
 * through the package name while another module imported the same file
 * relatively. The two imports resolved to different files, the Runtime loaded
 * two copies of the module, and module-scoped state split across them.
 */
test("a module imported by package name and by path is one module in the installed tree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-mirror-"));
  const installed = path.join(root, "src");
  mkdirSync(path.join(installed, "router"), { recursive: true });
  writeFileSync(
    path.join(installed, "router", "routing.ts"),
    "export const state = { loaded: 0 };\n"
  );
  writeFileSync(
    path.join(installed, "consumer.ts"),
    'import { state as byName } from "@simulatorlife/autodev-runtime/router/routing";\n' +
      'import { state as byPath } from "./router/routing.ts";\n' +
      "export const same = byName === byPath;\n"
  );
  writeFileSync(
    path.join(installed, "package.json"),
    renderRuntimeMirrorPackage({
      runtimePackage: {
        name: "@simulatorlife/autodev-runtime",
        exports: { "./router/routing": "./src/router/routing.ts" }
      },
      materialized: new Set(["runtime/src/router/routing.ts"])
    })
  );

  const consumer = await import(
    pathToFileURL(path.join(installed, "consumer.ts")).href
  );
  assert.equal(
    consumer.same,
    true,
    "the installed tree loaded two copies of one Runtime module"
  );
});
