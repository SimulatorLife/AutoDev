/** OS confinement for the only currently admitted external MCP backend. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { MCP_SERVER_FILESYSTEM } from "../shared/tool-names.ts";

const packageName = "@modelcontextprotocol/server-filesystem";
const sandboxExecutable = "/usr/bin/sandbox-exec";
const manifestSchema = z.object({
  bin: z.union([z.string(), z.record(z.string(), z.string())])
});

export interface ExternalBackend {
  command: string;
  args: string[];
}

function resolveDirectNodeExecutable(node: string, cwd: string): string {
  const resolved = realpathSync(node);
  if (resolved === realpathSync(process.execPath)) return resolved;
  // Version-manager/package-manager shims (such as ~/Library/pnpm/bin/node)
  // re-exec the real Node binary at runtime, which Seatbelt's closed sandbox
  // blocks. Resolve the underlying Node executable before building the profile.
  try {
    const target = execFileSync(
      resolved,
      ["-e", "process.stdout.write(process.execPath)"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000
      }
    ).trim();
    if (target && path.isAbsolute(target) && existsSync(target)) {
      return realpathSync(target);
    }
  } catch {
    /* Fall back cleanly if the supplied path cannot evaluate a JS probe. */
  }
  return resolved;
}

/** No generic sandbox claim: admit a backend only after its specific scope,
 * environment and capabilities have been implemented and reviewed. */
export function externalFilesystemBackend(
  server: string,
  repositoryRoot: string,
  workspace: string,
  node: string
): ExternalBackend {
  if (server !== MCP_SERVER_FILESYSTEM)
    throw new Error(
      "No externally confined execution profile for MCP: " + server
    );
  if (process.platform !== "darwin" || !existsSync(sandboxExecutable))
    throw new Error("The external filesystem MCP requires macOS sandbox-exec");
  const modules = path.join(repositoryRoot, "node_modules");
  const packageRoot = realpathSync(path.join(modules, packageName));
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"))
  );
  const entry =
    typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin["mcp-server-filesystem"];
  if (!entry) throw new Error("Filesystem MCP executable is missing");
  const script = realpathSync(path.join(packageRoot, entry));
  const binary = resolveDirectNodeExecutable(node, workspace);
  return {
    command: sandboxExecutable,
    args: [
      "-p",
      filesystemSandboxProfile(workspace, realpathSync(modules), binary),
      binary,
      script,
      "--read-only",
      "--confine-roots",
      "--",
      workspace
    ]
  };
}

/** Default deny, including all network and writes. The only data readable
 * outside the workspace is installed code and system runtime support.
 * No shell startup, HOME/CODEX_HOME secret files or arbitrary executables. */
export function filesystemSandboxProfile(
  workspace: string,
  modules: string,
  node: string
): string {
  const literal = (value: string) => "(literal " + JSON.stringify(value) + ")";
  const subtree = (value: string) => "(subpath " + JSON.stringify(value) + ")";
  const roots = [
    workspace,
    modules,
    "/System",
    "/usr/lib",
    "/usr/share",
    "/Library/Apple/System"
  ];
  return [
    "(version 1)",
    "(deny default)",
    '(import "dyld-support.sb")',
    "(allow process-exec " + literal(node) + ")",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    "(allow file-read* " +
      [
        ...roots.map(subtree),
        literal(node),
        literal("/dev/null"),
        literal("/dev/random"),
        literal("/dev/urandom"),
        literal("/private/etc/localtime")
      ].join(" ") +
      ")",
    // Never expose local .env / .env.* secret files (including via symlinks)
    // through external MCP reads; permit only .env.example inside the workspace.
    '(deny file-read-data (regex #"/\\.env(\\.[^/]*)?(/|$)"))',
    "(allow file-read-data (require-all " +
      subtree(workspace) +
      ' (regex #"/\\.env\\.example$")))',
    "(allow file-write-data " + literal("/dev/null") + ")"
  ].join("\n");
}
