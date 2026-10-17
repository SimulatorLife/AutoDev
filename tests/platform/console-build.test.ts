import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildConsole,
  type ConsoleBuildDeps
} from "../../runtime/src/platform/console-build.ts";

function withTempRepo<T>(run: (repositoryRoot: string) => T): T {
  const repositoryRoot = mkdtempSync(
    path.join(tmpdir(), "autodev-console-build-")
  );
  try {
    return run(repositoryRoot);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
}

function dependencies(
  overrides: Partial<ConsoleBuildDeps> = {}
): ConsoleBuildDeps {
  return {
    fileExists: existsSync,
    remove: (filePath) => rmSync(filePath, { recursive: true, force: true }),
    rename: renameSync,
    readFile: (filePath) => readFileSync(filePath, "utf8"),
    writeFile: (filePath, content) => writeFileSync(filePath, content, "utf8"),
    run: () => {},
    ...overrides
  };
}

function createConsoleLayout(repositoryRoot: string): string {
  const consoleRoot = path.join(repositoryRoot, "console");
  const nextCli = path.join(
    consoleRoot,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next"
  );
  mkdirSync(path.dirname(nextCli), { recursive: true });
  writeFileSync(nextCli, "fixture Next CLI\n");
  return consoleRoot;
}

test("Console build publishes a complete staged build after preserving the old artifact", () =>
  withTempRepo((repositoryRoot) => {
    const consoleRoot = createConsoleLayout(repositoryRoot);
    const current = path.join(consoleRoot, ".next");
    mkdirSync(current);
    writeFileSync(path.join(current, "BUILD_ID"), "old-build\n");

    const commands: {
      executable: string;
      args: readonly string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }[] = [];
    buildConsole(
      { repositoryRoot, nodeBin: "/fixture/node" },
      dependencies({
        run: (executable, args, cwd, env) => {
          commands.push({ executable, args, cwd, env });
          const staging = env.AUTODEV_CONSOLE_BUILD_DIST_DIR;
          assert.match(staging ?? "", /^\.next-staging-\d+$/u);
          const stagingRoot = path.join(consoleRoot, staging ?? "");
          mkdirSync(path.join(stagingRoot, "types"), { recursive: true });
          writeFileSync(path.join(stagingRoot, "BUILD_ID"), "new-build\n");
          writeFileSync(
            path.join(consoleRoot, "next-env.d.ts"),
            `/// <reference path="./${staging}/types/routes.d.ts" />\n`
          );
        }
      })
    );

    const command = commands[0];
    assert.ok(command, "the installer invokes Next exactly once");
    assert.deepEqual(
      {
        executable: command.executable,
        args: command.args,
        cwd: command.cwd
      },
      {
        executable: "/fixture/node",
        args: [
          path.join(consoleRoot, "node_modules", "next", "dist", "bin", "next"),
          "build"
        ],
        cwd: consoleRoot
      }
    );
    assert.equal(
      command?.env.AUTODEV_CONSOLE_BUILD_DIST_DIR?.startsWith(".next-staging-"),
      true
    );
    assert.equal(
      readFileSync(path.join(current, "BUILD_ID"), "utf8"),
      "new-build\n"
    );
    assert.equal(existsSync(path.join(consoleRoot, ".next-previous")), false);
    assert.equal(
      existsSync(
        path.join(
          consoleRoot,
          command?.env.AUTODEV_CONSOLE_BUILD_DIST_DIR ?? ""
        )
      ),
      false
    );
    assert.match(
      readFileSync(path.join(consoleRoot, "next-env.d.ts"), "utf8"),
      /\.next\/types\/routes\.d\.ts/u
    );
  }));

test("a failed Next build leaves the serving artifact intact and removes its staging output", () =>
  withTempRepo((repositoryRoot) => {
    const consoleRoot = createConsoleLayout(repositoryRoot);
    const current = path.join(consoleRoot, ".next");
    mkdirSync(current);
    writeFileSync(path.join(current, "BUILD_ID"), "known-good\n");
    const originalTypeReference =
      '/// <reference path="./.next/types/routes.d.ts" />\n';
    writeFileSync(
      path.join(consoleRoot, "next-env.d.ts"),
      originalTypeReference
    );

    assert.throws(
      () =>
        buildConsole(
          { repositoryRoot },
          dependencies({
            run: (_executable, _args, cwd, env) => {
              const staging = env.AUTODEV_CONSOLE_BUILD_DIST_DIR ?? "";
              mkdirSync(path.join(cwd, staging), { recursive: true });
              writeFileSync(
                path.join(cwd, "next-env.d.ts"),
                `/// <reference path="./${staging}/types/routes.d.ts" />\n`
              );
              throw new Error("synthetic build failure");
            }
          })
        ),
      /synthetic build failure/u
    );

    assert.equal(
      readFileSync(path.join(current, "BUILD_ID"), "utf8"),
      "known-good\n"
    );
    assert.equal(existsSync(path.join(consoleRoot, ".next-previous")), false);
    assert.equal(
      readFileSync(path.join(consoleRoot, "next-env.d.ts"), "utf8"),
      originalTypeReference
    );
    assert.equal(
      existsSync(path.join(consoleRoot, `.next-staging-${process.pid}`)),
      false
    );
  }));

test("Next must emit a BUILD_ID before the staged artifact can replace production", () =>
  withTempRepo((repositoryRoot) => {
    const consoleRoot = createConsoleLayout(repositoryRoot);
    const current = path.join(consoleRoot, ".next");
    mkdirSync(current);
    writeFileSync(path.join(current, "BUILD_ID"), "known-good\n");

    assert.throws(
      () => buildConsole({ repositoryRoot }, dependencies()),
      /without producing the staged Console BUILD_ID/u
    );
    assert.equal(
      readFileSync(path.join(current, "BUILD_ID"), "utf8"),
      "known-good\n"
    );
  }));

test("Console build normalizes tsconfig.json, cleans dead staging dirs, and seeds incremental caches", () =>
  withTempRepo((repositoryRoot) => {
    const consoleRoot = createConsoleLayout(repositoryRoot);
    const current = path.join(consoleRoot, ".next");
    mkdirSync(path.join(current, "cache", "webpack"), { recursive: true });
    mkdirSync(path.join(current, "cache", "swc"), { recursive: true });
    writeFileSync(path.join(current, "BUILD_ID"), "old-build\n");
    writeFileSync(
      path.join(current, "cache", "webpack", "pack.gz"),
      "webpack-cache\n"
    );
    writeFileSync(path.join(current, "cache", "swc", " plugin"), "swc-cache\n");
    writeFileSync(
      path.join(current, "cache", ".tsbuildinfo"),
      "tsbuildinfo-cache\n"
    );
    writeFileSync(path.join(current, "cache", ".rscinfo"), "rscinfo-cache\n");

    // Dead PID staging directory should be cleaned before build
    const deadStaging = path.join(consoleRoot, ".next-staging-99999999");
    mkdirSync(deadStaging, { recursive: true });
    writeFileSync(path.join(deadStaging, "stale"), "stale\n");

    const tsconfigPath = path.join(consoleRoot, "tsconfig.json");
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          include: [
            "next-env.d.ts",
            "**/*.ts",
            ".next/types/**/*.ts",
            ".next-staging-99999999/types/**/*.ts"
          ]
        },
        null,
        2
      ) + "\n"
    );

    let observedPreBuildTsconfig = "";
    let observedSeededWebpackCache = false;
    let observedSeededTsbuildinfo = false;
    let observedSeededRscinfo = false;

    buildConsole(
      { repositoryRoot, nodeBin: "/fixture/node" },
      dependencies({
        run: (_executable, _args, cwd, env) => {
          observedPreBuildTsconfig = readFileSync(tsconfigPath, "utf8");
          const staging = env.AUTODEV_CONSOLE_BUILD_DIST_DIR ?? "";
          const stagingRoot = path.join(cwd, staging);
          observedSeededWebpackCache = existsSync(
            path.join(stagingRoot, "cache", "webpack", "pack.gz")
          );
          observedSeededTsbuildinfo = existsSync(
            path.join(stagingRoot, "cache", ".tsbuildinfo")
          );
          observedSeededRscinfo = existsSync(
            path.join(stagingRoot, "cache", ".rscinfo")
          );
          mkdirSync(path.join(stagingRoot, "types"), { recursive: true });
          writeFileSync(path.join(stagingRoot, "BUILD_ID"), "new-build\n");
          // Simulate Next appending its staging types path into tsconfig.json
          writeFileSync(
            tsconfigPath,
            JSON.stringify(
              {
                include: [
                  "next-env.d.ts",
                  "**/*.ts",
                  ".next/types/**/*.ts",
                  `${staging}/types/**/*.ts`
                ]
              },
              null,
              2
            ) + "\n"
          );
        }
      })
    );

    assert.equal(
      existsSync(deadStaging),
      false,
      "stale staging directory from a dead PID must be removed"
    );
    assert.equal(
      observedPreBuildTsconfig.includes(".next-staging-99999999"),
      false,
      "tsconfig.json must be cleaned of stale staging type paths before Next runs"
    );
    assert.equal(observedSeededWebpackCache, true);
    assert.equal(observedSeededTsbuildinfo, true);
    assert.equal(observedSeededRscinfo, true);
    const finalTsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
      include: string[];
    };
    assert.deepEqual(finalTsconfig.include, [
      "next-env.d.ts",
      "**/*.ts",
      ".next/types/**/*.ts"
    ]);
    assert.equal(
      existsSync(path.join(current, "cache", "webpack", "pack.gz")),
      true
    );
  }));

test("a failed Next build restores seeded caches and tsconfig.json to the serving artifact", () =>
  withTempRepo((repositoryRoot) => {
    const consoleRoot = createConsoleLayout(repositoryRoot);
    const current = path.join(consoleRoot, ".next");
    mkdirSync(path.join(current, "cache", "webpack"), { recursive: true });
    writeFileSync(path.join(current, "BUILD_ID"), "known-good\n");
    writeFileSync(
      path.join(current, "cache", "webpack", "pack.gz"),
      "webpack-cache\n"
    );
    writeFileSync(
      path.join(current, "cache", ".tsbuildinfo"),
      "tsbuildinfo-cache\n"
    );
    const tsconfigPath = path.join(consoleRoot, "tsconfig.json");
    const originalTsconfig =
      JSON.stringify(
        {
          include: ["next-env.d.ts", "**/*.ts", ".next/types/**/*.ts"]
        },
        null,
        2
      ) + "\n";
    writeFileSync(tsconfigPath, originalTsconfig);

    assert.throws(
      () =>
        buildConsole(
          { repositoryRoot },
          dependencies({
            run: (_executable, _args, cwd, env) => {
              const staging = env.AUTODEV_CONSOLE_BUILD_DIST_DIR ?? "";
              writeFileSync(
                tsconfigPath,
                JSON.stringify({ include: [`${staging}/types/**/*.ts`] })
              );
              mkdirSync(path.join(cwd, staging), { recursive: true });
              throw new Error("synthetic build failure");
            }
          })
        ),
      /synthetic build failure/u
    );

    assert.equal(readFileSync(tsconfigPath, "utf8"), originalTsconfig);
    assert.equal(
      readFileSync(path.join(current, "cache", "webpack", "pack.gz"), "utf8"),
      "webpack-cache\n"
    );
    assert.equal(
      readFileSync(path.join(current, "cache", ".tsbuildinfo"), "utf8"),
      "tsbuildinfo-cache\n"
    );
  }));
