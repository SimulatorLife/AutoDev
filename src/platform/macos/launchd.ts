import { execFileSync } from 'node:child_process';

export interface CommandResult { stdout: string; stderr: string; status: number | null }
export type CommandRunner = (command: string, args: string[]) => CommandResult;

export class LaunchdError extends Error {
  readonly result: CommandResult | undefined;
  constructor(message: string, result?: CommandResult) { super(message); this.result = result; }
}

const defaultRunner: CommandRunner = (command, args) => {
  try {
    return { stdout: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', status: 0 };
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number | null };
    return {
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
      status: failure.status ?? 1,
    };
  }
};

export interface LaunchdClientOptions { runner?: CommandRunner; uid?: number }

export class LaunchdClient {
  private readonly runner: CommandRunner;
  private readonly domain: string;

  constructor({ runner = defaultRunner, uid = typeof process.getuid === 'function' ? process.getuid() : 0 }: LaunchdClientOptions = {}) {
    this.runner = runner;
    this.domain = `gui/${uid}`;
  }

  bootstrap(plist: string): void { this.run(['bootstrap', this.domain, plist]); }
  enable(label: string): void { this.run(['enable', `${this.domain}/${label}`]); }
  bootout(label: string): void { this.run(['bootout', `${this.domain}/${label}`]); }
  kickstart(label: string): void { this.run(['kickstart', '-k', `${this.domain}/${label}`]); }
  print(label: string): string { return this.run(['print', `${this.domain}/${label}`]).stdout; }
  isLoaded(label: string): boolean { return this.runner('launchctl', ['print', `${this.domain}/${label}`]).status === 0; }

  private run(args: string[]): CommandResult {
    const result = this.runner('launchctl', args);
    if (result.status !== 0) throw new LaunchdError(`launchctl ${args.join(' ')} failed: ${result.stderr || result.stdout}`, result);
    return result;
  }
}
