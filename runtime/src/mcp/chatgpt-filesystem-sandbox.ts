/** OS confinement for the only currently admitted external MCP backend. */
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

/** No generic sandbox claim: admit a backend only after its specific scope,
 * environment and capabilities have been implemented and reviewed. */
export function externalFilesystemBackend(
  server: string,
  repositoryRoot: string,
  workspace: string,
  node: string
): ExternalBackend {
  if (server !== MCP_SERVER_FILESYSTEM)
    throw new Error("No externally confined execution profile for MCP: " + server);
  if (process.platform !== "darwin" || !existsSync(sandboxExecutable))
    throw new Error("The external filesystem MCP requires macOS sandbox-exec");
  const modules = path.join(repositoryRoot, "node_modules");
  const packageRoot = realpathSync(path.join(modules, packageName));
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin["mcp-server-filesystem"];
  if (!entry) throw new Error("Filesystem MCP executable is missing");
  const script = realpathSync(path.join(packageRoot, entry));
  const binary = realpathSync(node);
  return {
    command: sandboxExecutable,
    args: [
      "-p", filesystemSandboxProfile(workspace, realpathSync(modules), binary),
      binary, script, "--read-only", "--confine-roots", "--", workspace
    ]
  };
}

/** Default deny, including all network and writes. The only data readable
 * outside the workspace is installed code and system runtime support.
 * No shell startup, HOME/CODEX_HOME secret files or arbitrary executables. */
export function filesystemSandboxProfile(workspace: string, modules: string, node: string): string {
  const literal = (value: string) => "(literal " + JSON.stringify(value) + ")";
  const subtree = (value: string) => "(subpath " + JSON.stringify(value) + ")";
  const roots = [workspace, modules, "/System", "/usr/lib", "/usr/share", "/Library/Apple/System"];
  return [
    "(version 1)",
    "(deny default)",
    '(import "dyld-support.sb")',
    "(allow process-exec " + literal(node) + ")",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    "(allow file-read* " + [...roots.map(subtree), literal(node), literal("/dev/null"), literal("/dev/random"), literal("/dev/urandom"), literal("/private/etc/localtime")].join(" ") + ")",
    "(allow file-write-data " + literal("/dev/null") + ")"
  ].join("\n");
}
