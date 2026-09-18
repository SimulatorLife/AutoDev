import { UnmigratedRuntimeError } from './runtime.ts';
import { ConfigError } from '../config/toml.ts';
import type { RouterStatus } from '../router/status.ts';

import { startRouterServer } from '../router/server.ts';

export type RouterCommand = 'run' | 'ensure' | 'status';

export interface RouterCommandBackend {
  run(): number;
  ensure(): number;
  status(): RouterStatus;
}

const defaultRouterBackend: RouterCommandBackend = {
  run: () => {
    startRouterServer();
    return 0;
  },
  ensure: () => { throw new UnmigratedRuntimeError('router ensure'); },
  status: () => { throw new UnmigratedRuntimeError('router status'); },
};

export function dispatchRouterCommand(command: string, backend: RouterCommandBackend = defaultRouterBackend): number {
  if (command !== 'run' && command !== 'ensure' && command !== 'status') {
    throw new ConfigError(`unsupported router command: ${command || '(missing)'}`);
  }
  if (command === 'run') return backend.run();
  if (command === 'ensure') return backend.ensure();
  const status = backend.status();
  console.log(JSON.stringify(status, null, 2));
  return 0;
}
