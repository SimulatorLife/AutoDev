export interface EvaluationMetric {
  readonly name: string;
  readonly value: number;
  readonly threshold?: number;
  readonly pass: boolean;
}

export interface EvaluationResult {
  readonly id: string;
  readonly agentRole: string;
  readonly promptName?: string;
  readonly model: string;
  readonly metrics: readonly EvaluationMetric[];
  readonly passed: boolean;
  readonly timestamp: string;
}

export interface EvaluationDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly targetRole: string;
  readonly promptName?: string;
}
