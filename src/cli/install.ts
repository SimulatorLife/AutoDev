import { runInstallCheck } from "../platform/install-check.ts";
import { runInstallCommand } from "../platform/install-command.ts";
import { writeErrorLine } from "../shared/output.ts";

export interface InstallCommandBackend {
  install(args?: readonly string[]): number;
}

const defaultInstaller: InstallCommandBackend = {
  install: (args = []) =>
    args.length === 1 && args[0] === "--check"
      ? runInstallCheck()
      : runInstallCommand(args)
};

export function dispatchInstallCommand(
  backend: InstallCommandBackend = defaultInstaller,
  args: readonly string[] = []
): number {
  return backend.install(args);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = dispatchInstallCommand(undefined, process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `autodev install: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  }
}
