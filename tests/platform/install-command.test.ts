import assert from "node:assert/strict";
import test from "node:test";

import { runInstallCommand } from "@simulatorlife/autodev-runtime/platform/install-command";

test("typed install command rejects check mode until diagnostic ownership migrates", () => {
  assert.throws(
    () => runInstallCommand(["--check"]),
    /installer check boundary/
  );
});

test("typed install command rejects the removed Collector mode and contradictory OpenLIT flags", () => {
  assert.throws(
    () => runInstallCommand(["--enable-otel-collector"]),
    /unsupported install option/
  );
  assert.throws(
    () => runInstallCommand(["--disable-otel-collector"]),
    /unsupported install option/
  );
  assert.throws(
    () => runInstallCommand(["--disable-otel-collector"]),
    /unsupported install option/
  );
  assert.throws(
    () =>
      runInstallCommand([
        "--enable-openlit-ingress",
        "--disable-openlit-ingress"
      ]),
    /mutually exclusive/
  );
});

test("typed install command rejects unknown options", () => {
  assert.throws(
    () => runInstallCommand(["--unknown"]),
    /unsupported install option/
  );
});
