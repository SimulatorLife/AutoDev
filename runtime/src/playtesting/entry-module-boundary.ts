/**
The entry module a game declares, resolved inside the approved checkout.

A game names its entry module in a binding file. The name is resolved against
the integration directory, and the resolved path must stay inside the checkout
the sandbox mounts read-only. That check lives here so the conformance loader
and the adapter image agree on it, and so it is decided by the one owner of
path containment rather than by a second spelling of it.

The checkout is the boundary, not the integration directory: a game's code
lives in its own source tree, and a binding that could only name a module
beside the binding file would force every game to keep a copy of its entry
point inside `.autodev/`.
*/
import path from "node:path";

import { isPathWithin } from "@simulatorlife/autodev-data/files";

/**
Resolve a declared entry module, refusing anything outside the checkout.

The module must resolve strictly inside the checkout: the checkout itself is
not a module, and neither is anything above it. A name that resolves one
level above the checkout is refused here rather than being left to fail as a
missing module, because "outside the approved checkout" is the reason worth
reporting.

An absolute name is taken as it is stated and held to the same check.
*/
export function resolveEntryModule(
  integrationDirectory: string,
  checkoutRoot: string,
  entry: string
): string {
  const root = path.resolve(integrationDirectory);
  const boundary = path.resolve(checkoutRoot);
  const resolved = path.resolve(
    path.isAbsolute(entry) ? entry : path.join(root, entry)
  );
  if (resolved === boundary || !isPathWithin(boundary, resolved)) {
    throw new TypeError(
      "The declared entry module must resolve inside the approved checkout."
    );
  }
  return resolved;
}
