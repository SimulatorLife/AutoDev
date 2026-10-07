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

/**
 * How long a health read may take before it reports `unreachable`.
 *
 * Short enough that an operator opening `/memory` gets an answer rather than a
 * spinner, and long enough that a loaded database is not misreported as down.
 *
 * The pool's connect bound is deliberately longer than this, so the probe is
 * the thing that decides `unreachable` rather than a connect error arriving
 * first and making "we could not reach it" indistinguishable from "we never
 * tried". `runtime/tests/memory-pool-policy.test.ts` pins that ordering.
 */
export const MEMORY_STORAGE_PROBE_TIMEOUT_MS = 1500;

export interface PostgresMemoryHost {
  /** Builds a request-scoped service over the host's shared repository/pool. */
  createService(repositories: MemoryRepositoryRootResolver): MemoryService;
  /**
   * Whether the database answers, within the caller's deadline.
   *
   * Bounded on purpose, and that is the whole design. The `pg` driver's default
   * is to wait out the operating system's TCP timeout, so an unreachable database
   * turns every memory read into a request that never settles -- the exact
   * failure this product already records once in the OpenLIT fork, where
   * `/api/clickhouse` hung with no connector configured and twenty surfaces sat
   * behind a ping that never left `pending`. A health read that can hang is worse
   * than no health read, because it takes the page down with it.
   *
   * So the probe settles either way: it races the query against its own deadline
   * and reports `unreachable` on expiry. The losing query is left to finish or
   * fail on its own, which is harmless -- the pool is sized for this, and the
   * answer the caller needs is what the database had already done.
   */
  probe(timeoutMs: number): Promise<"reachable" | "unreachable">;
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
  const pool = createPgMemoryPool(options.databaseUrl);
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
    probe: async (timeoutMs) => {
      // `SELECT 1` rather than a schema or row query: the question is whether
      // the database answers, not what is in it. A status read that counted rows
      // would make "connected" depend on how much memory has been written.
      const query = pool
        .query("SELECT 1")
        .then(() => "reachable" as const)
        .catch(() => "unreachable" as const);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return query;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          query,
          new Promise<"unreachable">((resolve) => {
            deadline = setTimeout(() => resolve("unreachable"), timeoutMs);
            // The probe answers one page load; the timer must not be what holds
            // the Runtime's event loop open afterwards.
            deadline.unref?.();
          })
        ]);
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
      }
    },
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
