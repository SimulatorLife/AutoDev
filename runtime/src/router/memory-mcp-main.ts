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
  await start();
}
