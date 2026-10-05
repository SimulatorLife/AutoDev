export interface PromptAsset {
  readonly name: string;
  readonly path: string;
  readonly kind?: "command" | "role";
  readonly description?: string;
  readonly content?: string;
}

export interface PromptDocument {
  readonly name: string;
  readonly kind: "command" | "role";
  readonly path: string;
  readonly content: string;
  readonly revision: string;
}

export interface PromptVersion {
  readonly name: string;
  readonly versionHash: string;
  readonly content: string;
  readonly updatedAt: string;
}
