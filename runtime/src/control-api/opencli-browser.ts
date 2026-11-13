/**
 * The Control API's view of the opencli browser setting.
 *
 * The opencli providers share one browser, chosen by the operator: their own
 * Chrome through the Browser Bridge extension (the default) or a dedicated
 * Chrome for Testing. The setting is a file the opencli bridge watches
 * (`opencli-browser-setting.ts`), not router policy. The router registers
 * these functions as the Control API's opencli browser source.
 */
import type { ControlApiProviderBrowser } from "@simulatorlife/autodev-core";
import {
  opencliBrowserSettingFile,
  readOpencliDedicatedBrowser,
  writeOpencliDedicatedBrowser
} from "@simulatorlife/autodev-runtime/shared/opencli-browser-setting";
import { OPENCLI_PROVIDERS } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

/** The provider's browser, or `undefined` for a provider that drives none. */
export function opencliProviderBrowser(
  provider: string
): ControlApiProviderBrowser | undefined {
  return (OPENCLI_PROVIDERS as readonly string[]).includes(provider)
    ? { dedicated: readOpencliDedicatedBrowser(opencliBrowserSettingFile()) }
    : undefined;
}

/** Persist the setting for every opencli provider; returns the value it replaced. */
export function setOpencliDedicatedBrowser(dedicated: boolean): boolean {
  const file = opencliBrowserSettingFile();
  const previous = readOpencliDedicatedBrowser(file);
  writeOpencliDedicatedBrowser(file, dedicated);
  return previous;
}
