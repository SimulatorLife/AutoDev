import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveMcpCommand, runMcp } from "../../src/mcp/launcher.ts";
import { MCP_SERVER_CODEGRAPHCONTEXT } from "../../src/shared/tool-names.ts";

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
