export interface PromptAsset {
  readonly name: string;
  readonly path: string;
  readonly description?: string;
  readonly content?: string;
}

export interface PromptVersion {
  readonly name: string;
  readonly versionHash: string;
  readonly content: string;
  readonly updatedAt: string;
}
