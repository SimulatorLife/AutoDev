/** AutoDev-local type declarations for the unchanged upstream core.js file. */
export interface JevObservation {
  readonly goal: string;
  readonly state: unknown;
  readonly legalActions: readonly { readonly id: string }[];
}

export interface JevLoopInspection {
  readonly loop: boolean;
  readonly signature: string;
}

export class LoopGuard {
  constructor(options?: {
    readonly window?: number;
    readonly maxRepeats?: number;
  });
  inspect(observation: JevObservation, actionId: string): JevLoopInspection;
}

export function observationHash(observation: JevObservation): string;
