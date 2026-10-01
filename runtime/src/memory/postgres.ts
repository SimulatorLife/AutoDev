import type { Tracer } from "@opentelemetry/api";
import {
  createPgMemoryPool,
  MEMORY_EMBEDDING_DIMENSIONS,
  PostgresMemoryRepository
} from "@simulatorlife/autodev-data";

import {
  GitWorkingTreeMemoryVerifier,
  type MemoryRepositoryRootResolver,
  VerifiedMemoryReconstructor
} from "./git-curation.ts";
import {
  type MemoryCurrentStateVerifier,
  type MemoryEmbeddingProvider,
  type MemoryReconstructor,
  MemoryService,
  type MemorySkillPromotionWriter
} from "./service.ts";
import { RuleSyncMemorySkillPromoter } from "./skill-promotion.ts";

export interface PostgresMemoryHostOptions {
  readonly databaseUrl: string;
  readonly embedder?: MemoryEmbeddingProvider;
  readonly tracer?: Tracer;
  readonly now?: () => string;
  readonly countTokens?: (text: string) => number;
  readonly verifier?: MemoryCurrentStateVerifier;
  readonly reconstructor?: MemoryReconstructor;
  readonly maxResearchCandidates?: number;
  readonly skillPromotionWriter?: MemorySkillPromotionWriter;
}

export interface PostgresMemoryRuntimeOptions extends PostgresMemoryHostOptions {
  readonly repositories: MemoryRepositoryRootResolver;
}

export interface PostgresMemoryHost {
  /** Builds a request-scoped service over the host's shared repository/pool. */
  createService(repositories: MemoryRepositoryRootResolver): MemoryService;
  close(): Promise<void>;
}

export interface PostgresMemoryRuntime {
  readonly service: MemoryService;
  close(): Promise<void>;
}

/**
 * Compose the canonical PostgreSQL repository and reusable Runtime service
 * host. Schema changes remain explicit through the Data package's
 * `memory:migrate` command; starting a request-serving runtime never performs
 * DDL implicitly. One host can safely reuse its pool while creating a
 * repository-root-scoped verifier for each task.
 */
export function createPostgresMemoryHost(
  options: PostgresMemoryHostOptions
): PostgresMemoryHost {
  if (!options.databaseUrl.trim())
    throw new TypeError("A PostgreSQL memory database URL is required.");
  const pool = createPgMemoryPool({
    connectionString: options.databaseUrl,
    max: 2,
    idleTimeoutMillis: 5000,
    allowExitOnIdle: true
  });
  const repository = new PostgresMemoryRepository({
    pool,
    vectorSupport: { dimensions: MEMORY_EMBEDDING_DIMENSIONS }
  });

  return {
    createService: (repositories) =>
      new MemoryService({
        repository,
        verifier:
          options.verifier ??
          new GitWorkingTreeMemoryVerifier({
            repositories,
            ...(options.now ? { now: options.now } : {})
          }),
        reconstructor:
          options.reconstructor ?? new VerifiedMemoryReconstructor(),
        skillPromotionWriter:
          options.skillPromotionWriter ??
          new RuleSyncMemorySkillPromoter(repositories),
        ...(options.embedder ? { embedder: options.embedder } : {}),
        ...(options.tracer ? { tracer: options.tracer } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.countTokens ? { countTokens: options.countTokens } : {}),
        ...(typeof options.maxResearchCandidates === "number"
          ? { maxResearchCandidates: options.maxResearchCandidates }
          : {})
      }),
    close: () => pool.end()
  };
}

/** One-service convenience adapter for callers already bound to one repository. */
export function createPostgresMemoryRuntime(
  options: PostgresMemoryRuntimeOptions
): PostgresMemoryRuntime {
  const host = createPostgresMemoryHost(options);
  return {
    service: host.createService(options.repositories),
    close: () => host.close()
  };
}
