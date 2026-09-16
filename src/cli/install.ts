import { UnmigratedRuntimeError } from './runtime.ts';

export interface InstallCommandBackend {
  install(): number;
}

const unmigratedInstaller: InstallCommandBackend = {
  install: () => { throw new UnmigratedRuntimeError('install'); },
};

export function dispatchInstallCommand(backend: InstallCommandBackend = unmigratedInstaller): number {
  return backend.install();
}

