import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findCocoindexProjectRoot,
  resolveMcpCommand,
  resolveMcpWorkspace,
  runMcp
} from "@simulatorlife/autodev-runtime/mcp";
import { MCP_SERVER_CODEGRAPHCONTEXT } from "@simulatorlife/autodev-runtime/shared/tool-names";

test("MCP launcher resolves pinned AutoDev binaries without shell commands", () => {
  assert.deepEqual(resolveMcpCommand("lsp", "/repo"), {
    binary: "/repo/node_modules/.bin/lsp-mcp-server",
    args: [],
    pathPrepend: ["/repo/node_modules/.bin"]
  });
  assert.deepEqual(resolveMcpCommand("playwright", "/repo"), {
    binary: "/repo/node_modules/.bin/playwright-mcp",
    args: [],
    pathPrepend: []
  });
  assert.deepEqual(
    resolveMcpCommand("cocoindex-code", "/repo", {
      AUTODEV_COCOINDEX_BIN: "/custom/ccc"
    }),
    { binary: "/custom/ccc", args: ["mcp"], pathPrepend: [] }
  );
  assert.deepEqual(
    resolveMcpCommand(MCP_SERVER_CODEGRAPHCONTEXT, "/repo", {
      AUTODEV_CODEGRAPHCONTEXT_BIN: "/custom/codegraphcontext"
    }),
    {
      binary: "/custom/codegraphcontext",
      args: ["mcp", "start"],
      pathPrepend: []
    }
  );
});

test("MCP launcher fails clearly when codegraphcontext is missing", () => {
  assert.throws(
    () =>
      resolveMcpCommand(MCP_SERVER_CODEGRAPHCONTEXT, "/repo", {
        PATH: "",
        HOME: "/nonexistent"
      }),
    /AutoDev CodeGraphContext MCP binary is missing; install codegraphcontext or set AUTODEV_CODEGRAPHCONTEXT_BIN/
  );
});

test("MCP launcher rejects unknown tools", () => {
  assert.throws(
    () => resolveMcpCommand("unknown", "/repo"),
    /unsupported AutoDev MCP/
  );
});

test("runMcp auto-initializes cocoindex-code if .cocoindex_code is absent", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "autodev-mcp-launcher-"));
  const prevCwd = process.cwd();
  try {
    const mockBin = join(tempDir, "mock-ccc");
    writeFileSync(
      mockBin,
      '#!/usr/bin/env bash\nif [ "$1" = "init" ]; then mkdir -p .cocoindex_code; fi\nexit 0\n'
    );
    chmodSync(mockBin, 0o755);

    process.chdir(tempDir);
    assert.equal(existsSync(join(tempDir, ".cocoindex_code")), false);

    const status = runMcp("cocoindex-code", tempDir, {
      ...process.env,
      AUTODEV_COCOINDEX_BIN: mockBin
    });
    assert.equal(status, 0);
    assert.equal(existsSync(join(tempDir, ".cocoindex_code")), true);
  } finally {
    process.chdir(prevCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveMcpWorkspace keeps the caller's directory unless it declares a workspace", () => {
  assert.equal(resolveMcpWorkspace({}, "/callers/dir"), "/callers/dir");
  assert.equal(
    resolveMcpWorkspace({ AUTODEV_MCP_WORKSPACE: "  " }, "/callers/dir"),
    "/callers/dir"
  );
});

test("resolveMcpWorkspace reports why a declared workspace is unusable", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "autodev-mcp-workspace-"));
  try {
    assert.equal(
      resolveMcpWorkspace({ AUTODEV_MCP_WORKSPACE: tempDir }, "/callers/dir"),
      tempDir
    );
    assert.throws(
      () =>
        resolveMcpWorkspace(
          { AUTODEV_MCP_WORKSPACE: "relative/dir" },
          "/callers/dir"
        ),
      /AUTODEV_MCP_WORKSPACE must be an absolute path/
    );
    assert.throws(
      () =>
        resolveMcpWorkspace(
          { AUTODEV_MCP_WORKSPACE: join(tempDir, "absent") },
          "/callers/dir"
        ),
      /AUTODEV_MCP_WORKSPACE does not exist/
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("findCocoindexProjectRoot agrees with the ancestor walk ccc performs", () => {
  const repo = mkdtempSync(join(tmpdir(), "autodev-cocoindex-root-"));
  try {
    const nested = join(repo, "runtime", "src", "mcp");
    mkdirSync(nested, { recursive: true });
    assert.equal(findCocoindexProjectRoot(nested), null);

    mkdirSync(join(repo, ".cocoindex_code"));
    assert.equal(findCocoindexProjectRoot(nested), repo);
    assert.equal(findCocoindexProjectRoot(repo), repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runMcp serves cocoindex-code from the declared workspace, not the caller's directory", () => {
  // The desktop runtime starts MCP servers from its own process directory, so
  // inheriting cwd left `ccc mcp` with no project and it exited with
  // "Not in an initialized project directory".
  const root = mkdtempSync(join(tmpdir(), "autodev-mcp-declared-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "autodev-mcp-caller-"));
  const prevCwd = process.cwd();
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const mockBin = join(root, "mock-ccc");
    const seenCwd = join(root, "seen-cwd");
    writeFileSync(
      mockBin,
      `#!/usr/bin/env bash\nif [ "$1" = "init" ]; then mkdir -p .cocoindex_code; fi\npwd > "${seenCwd}"\nexit 0\n`
    );
    chmodSync(mockBin, 0o755);

    process.chdir(elsewhere);
    const status = runMcp("cocoindex-code", root, {
      ...process.env,
      AUTODEV_COCOINDEX_BIN: mockBin,
      AUTODEV_MCP_WORKSPACE: workspace
    });
    assert.equal(status, 0);
    // macOS may spell a temp workspace as /tmp or /private/tmp; the spawned
    // process reports the physical cwd, which must still be the declared workspace.
    assert.equal(readFileSync(seenCwd, "utf8").trim(), realpathSync(workspace));
    assert.equal(existsSync(join(workspace, ".cocoindex_code")), true);
    assert.equal(existsSync(join(elsewhere, ".cocoindex_code")), false);
  } finally {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("runMcp refuses a workspace it cannot initialize instead of serving the wrong project", () => {
  const root = mkdtempSync(join(tmpdir(), "autodev-mcp-uninitializable-"));
  const prevCwd = process.cwd();
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const mockBin = join(root, "mock-ccc");
    writeFileSync(mockBin, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(mockBin, 0o755);

    process.chdir(root);
    assert.throws(
      () =>
        runMcp("cocoindex-code", root, {
          ...process.env,
          AUTODEV_COCOINDEX_BIN: mockBin,
          AUTODEV_MCP_WORKSPACE: workspace
        }),
      /AutoDev cocoindex-code has no project under .*workspace/
    );
  } finally {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the LSP server finds the language servers AutoDev pins, whatever PATH Codex starts it with", () => {
  // Observed 2026-09-18: under Codex's environment lsp-mcp-server could not
  // spawn `typescript-language-server` (ENOENT) and exited on its first
  // TypeScript request, which agents saw as "Transport closed".
  const repo = mkdtempSync(join(tmpdir(), "autodev-mcp-lsp-"));
  try {
    const bin = join(repo, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const seen = join(repo, "seen");
    writeFileSync(
      join(bin, "typescript-language-server"),
      "#!/usr/bin/env bash\nexit 0\n"
    );
    writeFileSync(
      join(bin, "lsp-mcp-server"),
      `#!/usr/bin/env bash\ncommand -v typescript-language-server > "${seen}"\n`
    );
    chmodSync(join(bin, "typescript-language-server"), 0o755);
    chmodSync(join(bin, "lsp-mcp-server"), 0o755);
    const status = runMcp("lsp", repo, {
      HOME: process.env.HOME,
      PATH: "/usr/bin:/bin"
    });
    assert.equal(status, 0);
    assert.equal(
      readFileSync(seen, "utf8").trim(),
      join(bin, "typescript-language-server")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
