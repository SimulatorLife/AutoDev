import type { MemoryReadContext } from "@simulatorlife/autodev-core";
import {
  RuleSyncRepository,
  RuleSyncSkillConflictError
} from "@simulatorlife/autodev-data";

import type { MemoryRepositoryRootResolver } from "./git-curation.ts";
import {
  MemoryConflictError,
  type MemorySkillPromotionWriter,
  MemoryValidationError
} from "./service.ts";

/** Writes operator-authored, verified procedures only into canonical RuleSync skills. */
export class RuleSyncMemorySkillPromoter implements MemorySkillPromotionWriter {
  private readonly repositories: MemoryRepositoryRootResolver;

  constructor(repositories: MemoryRepositoryRootResolver) {
    this.repositories = repositories;
  }

  async createSkill(input: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
    readonly context: MemoryReadContext;
  }): ReturnType<MemorySkillPromotionWriter["createSkill"]> {
    if (!input.context.repositoryId)
      throw new MemoryValidationError(
        "Canonical skill promotion requires an explicit repository scope."
      );
    const root = await this.repositories.resolve(input.context);
    if (!root)
      throw new MemoryValidationError(
        "No trusted repository root is available for skill promotion."
      );
    try {
      return await new RuleSyncRepository(root).createSkill({
        name: input.name,
        description: input.description,
        content: input.content
      });
    } catch (error) {
      if (error instanceof RuleSyncSkillConflictError)
        throw new MemoryConflictError(error.message);
      if (error instanceof TypeError)
        throw new MemoryValidationError(error.message);
      throw error;
    }
  }
}
