export interface WorkspaceEntry {
  readonly name: string;
  readonly baseBranch: string;
  readonly weight: number;
}

export interface WorkspaceAttribution {
  readonly workspace: string;
  readonly workspaceId?: string;
  readonly isLocal: boolean;
}
