import { execFileSync } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
}
export type CommandRunner = (command: string, args: string[]) => CommandResult;

export class LaunchdError extends Error {
  readonly result: CommandResult | undefined;
  constructor(message: string, result?: CommandResult) {
    super(message);
    this.result = result;
  }
}

const defaultRunner: CommandRunner = (command, args) => {
  try {
    return {
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }),
      stderr: "",
      status: 0
    };
  } catch (error) {
    const failure = error as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
    };
    return {
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
      status: failure.status ?? 1
    };
  }
};

export interface LaunchdClientOptions {
  runner?: CommandRunner;
  uid?: number;
  /** Bounded wait for `bootout` to finish unloading before the caller re-bootstraps. */
  unloadAttempts?: number;
  unloadDelayMs?: number;
  sleep?: (ms: number) => void;
}

// Covers the longest ExitTimeOut we ship (the router's 45s drain budget):
// launchd SIGKILLs a job by then, so unloading must have finished.
const UNLOAD_ATTEMPTS_DEFAULT = 500;
const UNLOAD_DELAY_MS_DEFAULT = 100;

/** `launchctl bootout` returns before launchd finishes tearing the job down. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class LaunchdClient {
  private readonly runner: CommandRunner;
  private readonly domain: string;
  private readonly unloadAttempts: number;
  private readonly unloadDelayMs: number;
  private readonly sleep: (ms: number) => void;

  constructor({
    runner = defaultRunner,
    uid = typeof process.getuid === "function" ? process.getuid() : 0,
    unloadAttempts = UNLOAD_ATTEMPTS_DEFAULT,
    unloadDelayMs = UNLOAD_DELAY_MS_DEFAULT,
    sleep = sleepSync
  }: LaunchdClientOptions = {}) {
    this.runner = runner;
    this.domain = `gui/${uid}`;
    this.unloadAttempts = unloadAttempts;
    this.unloadDelayMs = unloadDelayMs;
    this.sleep = sleep;
  }

  bootstrap(plist: string): void {
    this.run(["bootstrap", this.domain, plist]);
  }
  enable(label: string): void {
    this.run(["enable", `${this.domain}/${label}`]);
  }
  /**
   * Unload a job (a no-op when it is not loaded) and block until launchd has
   * torn it down. `launchctl bootout` is asynchronous, and bootstrapping the
   * same label while it is still loaded fails with `Bootstrap failed: 5:
   * Input/output error`, so a job that outlives the wait is an error.
   */
  bootout(label: string): void {
    if (!this.isLoaded(label)) return;
    this.run(["bootout", `${this.domain}/${label}`]);
    if (!this.waitUntilUnloaded(label))
      throw new LaunchdError(
        `${this.domain}/${label} was still loaded ${this.unloadAttempts * this.unloadDelayMs}ms after bootout`
      );
  }

  /** True once the label is gone; false when it is still loaded after the bounded wait. */
  waitUntilUnloaded(label: string): boolean {
    for (let attempt = 0; attempt < this.unloadAttempts; attempt += 1) {
      if (!this.isLoaded(label)) return true;
      this.sleep(this.unloadDelayMs);
    }
    return !this.isLoaded(label);
  }
  kickstart(label: string): void {
    this.run(["kickstart", "-k", `${this.domain}/${label}`]);
  }
  print(label: string): string {
    return this.run(["print", `${this.domain}/${label}`]).stdout;
  }
  isLoaded(label: string): boolean {
    return (
      this.runner("launchctl", ["print", `${this.domain}/${label}`]).status ===
      0
    );
  }

  private run(args: string[]): CommandResult {
    const result = this.runner("launchctl", args);
    if (result.status !== 0)
      throw new LaunchdError(
        `launchctl ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
        result
      );
    return result;
  }
}
