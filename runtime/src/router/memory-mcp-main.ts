import { pathToFileURL } from "node:url";

import type { MemoryEmbeddingProvider } from "@simulatorlife/autodev-runtime/memory";

import { startMemoryMcpFromEnvironment } from "../memory/mcp-main.ts";

async function optionalEmbeddingProvider(): Promise<
  MemoryEmbeddingProvider | undefined
> {
  let embedder: MemoryEmbeddingProvider | undefined;
  if (process.env.AUTODEV_MEMORY_EMBEDDING_MODEL?.trim()) {
    try {
      const { configuredMemoryEmbeddingProvider } =
        await import("./memory-embedding.ts");
      embedder = configuredMemoryEmbeddingProvider();
    } catch {
      try {
        process.stderr.write(
          "memory-mcp: embedding route unavailable; lexical retrieval remains enabled.\n"
        );
      } catch {
        // Diagnostics must not prevent the memory server from using lexical search.
      }
    }
  }
  return embedder;
}

async function start(): Promise<void> {
  await startMemoryMcpFromEnvironment(await optionalEmbeddingProvider());
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    await start();
  } catch (error) {
    // Reported the way the other two memory entry points report, and it matters
    // more here than for them. An MCP host forwards this process's stderr to
    // the model, so an uncaught rejection turned a one-line misconfiguration
    // into twelve lines of Node stack trace — internal frames and source
    // locations, in the agent's context, every time the server is launched
    // without a database URL.
    const message =
      error instanceof Error ? error.message : "Memory MCP failed to start.";
    process.stderr.write(`memory-mcp: ${message}\n`);
    process.exitCode = 1;
  }
}
