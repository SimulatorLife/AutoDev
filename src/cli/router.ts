import { UnmigratedRuntimeError } from './runtime.ts';
import { ConfigError } from '../config/toml.ts';
import type { RouterStatus } from '../router/status.ts';

export type RouterCommand = 'run' | 'ensure' | 'status';

export interface RouterCommandBackend {
  run(): number;
  ensure(): number;
  status(): RouterStatus;
}

const unmigratedRouter: RouterCommandBackend = {
  run: () => { throw new UnmigratedRuntimeError('router run'); },
  ensure: () => { throw new UnmigratedRuntimeError('router ensure'); },
  status: () => { throw new UnmigratedRuntimeError('router status'); },
};

export function dispatchRouterCommand(command: string, backend: RouterCommandBackend = unmigratedRouter): number {
  if (command !== 'run' && command !== 'ensure' && command !== 'status') {
    throw new ConfigError(`unsupported router command: ${command || '(missing)'}`);
  }
  if (command === 'run') return backend.run();
  if (command === 'ensure') return backend.ensure();
  const status = backend.status();
  console.log(JSON.stringify(status, null, 2));
  return 0;
}
