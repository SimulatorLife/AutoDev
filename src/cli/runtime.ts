import { ConfigError } from '../config/toml.ts';

/** Raised when a CLI boundary exists but its runtime implementation is not migrated yet. */
export class UnmigratedRuntimeError extends ConfigError {
  constructor(command: string) {
    super(`${command} runtime backend is not migrated; direct TypeScript execution is unavailable`);
    this.name = 'UnmigratedRuntimeError';
  }
}

