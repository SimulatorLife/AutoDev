import {
  runInstallCheck,
  runInstallCommand
} from "@simulatorlife/autodev-runtime/platform";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

export interface InstallCommandBackend {
  install(arguments_?: readonly string[]): number;
}

const defaultInstaller: InstallCommandBackend = {
  install: (arguments_ = []) =>
    arguments_.length === 1 && arguments_[0] === "--check"
      ? runInstallCheck()
      : runInstallCommand(arguments_)
};

export function dispatchInstallCommand(
  backend: InstallCommandBackend = defaultInstaller,
  arguments_: readonly string[] = []
): number {
  return backend.install(arguments_);
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = dispatchInstallCommand(undefined, process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `autodev install: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  }
}
