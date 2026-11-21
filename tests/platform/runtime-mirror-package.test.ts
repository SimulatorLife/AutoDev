import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  renderRuntimeMirrorPackage,
  renderTransitionalRuntimeMirrorPackage
} from "@simulatorlife/autodev-runtime/platform/runtime-mirror-package";

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

/**
 * The failure this guards: an install copied an updated module that imported
 * a new subpath before it rewrote the manifest, and a bridge launchd restarted
 * in between crashed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. While files are
 * replaced, the manifest must export the subpaths of both versions.
 */
test("the transitional manifest exports the installed and the next subpaths", () => {
  const installed = renderRuntimeMirrorPackage({
    runtimePackage: {
      name: "@simulatorlife/autodev-runtime",
      exports: {
        "./router/routing": "./src/router/routing.ts",
        "./shared/retired": "./src/shared/retired.ts"
      }
    },
    materialized: new Set([
      "runtime/src/router/routing.ts",
      "runtime/src/shared/retired.ts"
    ])
  });
  const next = renderRuntimeMirrorPackage({
    runtimePackage: {
      name: "@simulatorlife/autodev-runtime",
      exports: {
        "./router/routing": "./src/router/routing-next.ts",
        "./shared/compaction": "./src/shared/compaction.ts"
      }
    },
    materialized: new Set([
      "runtime/src/router/routing-next.ts",
      "runtime/src/shared/compaction.ts"
    ])
  });

  const manifest = JSON.parse(
    renderTransitionalRuntimeMirrorPackage(next, installed)
  ) as { name: string; type: string; exports: Record<string, string> };

  assert.equal(manifest.name, "@simulatorlife/autodev-runtime");
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.exports, {
    "./router/routing": "./router/routing-next.ts",
    "./shared/retired": "./shared/retired.ts",
    "./shared/compaction": "./shared/compaction.ts"
  });
});

test("the transitional manifest is the next manifest when none is installed or readable", () => {
  const next = renderRuntimeMirrorPackage({
    runtimePackage: RUNTIME_PACKAGE,
    materialized: new Set(["runtime/src/router/routing.ts"])
  });
  assert.deepEqual(
    JSON.parse(renderTransitionalRuntimeMirrorPackage(next, null)),
    JSON.parse(next)
  );
  assert.deepEqual(
    JSON.parse(renderTransitionalRuntimeMirrorPackage(next, "{ not json")),
    JSON.parse(next)
  );
});

test("a module importing a new subpath resolves under the transitional manifest", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-mirror-"));
  const installed = path.join(root, "src");
  mkdirSync(path.join(installed, "shared"), { recursive: true });
  const runtimePackage = (subpaths: string[]) => ({
    name: "@simulatorlife/autodev-runtime",
    exports: Object.fromEntries(
      subpaths.map((subpath) => [`./shared/${subpath}`, `./src/shared/${subpath}.ts`])
    )
  });
  const materialized = (subpaths: string[]) =>
    new Set(subpaths.map((subpath) => `runtime/src/shared/${subpath}.ts`));
  const before = renderRuntimeMirrorPackage({
    runtimePackage: runtimePackage(["output"]),
    materialized: materialized(["output"])
  });
  const next = renderRuntimeMirrorPackage({
    runtimePackage: runtimePackage(["output", "compaction"]),
    materialized: materialized(["output", "compaction"])
  });
  // Mid-install: the new module and an updated importer have landed.
  writeFileSync(
    path.join(installed, "shared", "compaction.ts"),
    "export const compacted = true;\n"
  );
  writeFileSync(
    path.join(installed, "shared", "output.ts"),
    'export { compacted } from "@simulatorlife/autodev-runtime/shared/compaction";\n'
  );
  writeFileSync(
    path.join(installed, "package.json"),
    renderTransitionalRuntimeMirrorPackage(next, before)
  );

  const output = await import(
    pathToFileURL(path.join(installed, "shared", "output.ts")).href
  );
  assert.equal(output.compacted, true);
});
