import {
  autodevStateHome
} from "@simulatorlife/autodev-runtime/shared/autodev-home";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";



export function codexHome(): string {
  return autodevStateHome();
}

export function repositoryRoot(): string {
  return resolveRuntimeSourceRoot(
    import.meta.dirname,
    process.env.AUTODEV_REPO_ROOT
  );
}

export {autodevHome, autodevStateHome} from "@simulatorlife/autodev-runtime/shared/autodev-home";