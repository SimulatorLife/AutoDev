import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const IMAGE_ID =
  "sha256:92b0ff83ef1cd99278da42deccec15fb0797620e11a931ced5fa0fae0bcf575b";

/**
 * The failure Docker Desktop's API proxy produces when the Engine does not
 * answer within its 10-second deadline, and the message Compose derives from
 * it. The version in the message is the one Compose asked with, and the Engine
 * serves it: the Engine simply did not answer in time.
 */
const ENGINE_TIMEOUT_COMPOSE_ERROR = [
  "dependency failed to start: request returned 500 Internal Server Error for API route and version http://%2FUsers%2Fhenrykirk%2F.docker%2Frun%2Fdocker.sock/v1.51/containers/c98f3e577bcf249a7bcb1e3b20b65921eeefe0f017fdf8ff191d7e05e1f267ae/json, check if the server supports the requested API version"
].join("\n");

/** A Compose failure that no retry can fix. */
const DETERMINISTIC_COMPOSE_ERROR = [
  "validating config/openlit/docker-compose.yml: services.clickhouse.environment must be a mapping"
].join("\n");

/**
 * The health-gate failure a starved Engine produces: the health check cannot
 * start inside the container, so the container is recorded unhealthy and
 * Compose refuses to start the service that depends on it.
 */
const UNHEALTHY_DEPENDENCY_COMPOSE_ERROR = [
  "dependency failed to start: container openlit-clickhouse is unhealthy"
].join("\n");

interface Fixture {
  readonly root: string;
  readonly codexHome: string;
  readonly bin: string;
  readonly state: string;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/**
 * A throwaway repository root with stubbed `docker`, `curl`, and `pnpm` on the
 * PATH, so the real `up.sh` runs end to end without a Docker Engine, a
 * ClickHouse, or a network.
 */
function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "autodev-openlit-up-"));
  const codexHome = mkdtempSync(join(tmpdir(), "autodev-openlit-codex-"));
  const bin = mkdtempSync(join(tmpdir(), "autodev-openlit-bin-"));
  const state = mkdtempSync(join(tmpdir(), "autodev-openlit-state-"));

  mkdirSync(join(root, "config", "openlit", "assets"), { recursive: true });
  mkdirSync(join(root, "patches", "openlit"), { recursive: true });
  mkdirSync(join(root, "console"), { recursive: true });
  mkdirSync(join(root, "scripts", "openlit"), { recursive: true });

  writeFileSync(
    join(root, "config", "openlit", "docker-compose.yml"),
    "services:\n  clickhouse:\n    image: clickhouse/clickhouse-server:24.4.1\n"
  );
  writeFileSync(join(root, "config", "openlit", "openlit.env"), "PORT=3000\n");
  for (const asset of [
    "clickhouse-config.xml",
    "clickhouse-init.sh",
    "otel-collector-config.yaml"
  ]) {
    writeFileSync(join(root, "config", "openlit", "assets", asset), "stub\n");
  }
  writeFileSync(join(root, "patches", "openlit", "01-stub.patch"), "stub\n");

  copyFileSync(
    join(repositoryRoot, "scripts", "openlit", "up.sh"),
    join(root, "scripts", "openlit", "up.sh")
  );
  copyFileSync(
    join(repositoryRoot, "scripts", "openlit", "bootstrap-secrets.sh"),
    join(root, "scripts", "openlit", "bootstrap-secrets.sh")
  );
  copyFileSync(
    join(repositoryRoot, "scripts", "openlit", "bootstrap-otlp-key.sh"),
    join(root, "scripts", "openlit", "bootstrap-otlp-key.sh")
  );
  chmodSync(join(root, "scripts", "openlit", "bootstrap-secrets.sh"), 0o755);
  chmodSync(join(root, "scripts", "openlit", "bootstrap-otlp-key.sh"), 0o755);

  // The build step only has to publish the lock file the runner verifies.
  writeExecutable(
    join(root, "scripts", "openlit", "build-local.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
cat > "$AUTODEV_OPENLIT_LOCK_FILE" <<LOCK
AUTODEV_OPENLIT_PINNED_COMMIT=9938c66638666ca5d3bcb850350faa82e510924b
AUTODEV_OPENLIT_PATCH_SET_HASH=c92e721b28270f33
AUTODEV_OPENLIT_IMAGE_TAG=autodev-openlit:openlit-9938c6663866-pc92e721b28270f33
AUTODEV_OPENLIT_IMAGE_ID=$STUB_IMAGE_ID
AUTODEV_OPENLIT_IMAGE_DIGEST=$STUB_IMAGE_ID
AUTODEV_OPENLIT_IMAGE_LOCK_BUILT_AT=2026-10-24T13:59:54Z
LOCK
`
  );

  writeExecutable(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -uo pipefail
case "\${1:-}" in
  info)
    # The Engine answers until the stack has been asked to start once, so the
    # "engine stops answering" case models a failure during the Compose phase
    # rather than a missing prerequisite.
    if [[ -f "$STUB_STATE_DIR/engine-down" && -s "$STUB_STATE_DIR/compose-calls" ]]; then
      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2
      exit 1
    fi
    exit 0
    ;;
  image)
    printf '%s\\n' "$STUB_IMAGE_ID"
    exit 0
    ;;
  compose)
    # Compose is invoked as \`compose --env-file … -f … up -d\` and as
    # \`compose -f … exec -T …\`, so the subcommand is found by scanning the
    # arguments rather than by position.
    mode=""
    for argument in "$@"; do
      case "$argument" in
        version) mode="version" ;;
        up) mode="up" ;;
        exec) mode="exec" ;;
      esac
    done
    if [[ "$mode" == "version" ]]; then
      exit 0
    fi
    if [[ "$mode" == "exec" ]]; then
      # The in-container query answers only while the stack is ready.
      if [[ -f "$STUB_STATE_DIR/readiness-down" ]]; then
        exit 22
      fi
      exit 0
    fi
    if [[ "$mode" == "up" ]]; then
      calls=$(( $(cat "$STUB_STATE_DIR/compose-calls" 2>/dev/null || echo 0) + 1 ))
      printf '%s' "$calls" > "$STUB_STATE_DIR/compose-calls"
      if [[ "$calls" -le "$STUB_COMPOSE_FAILURES" ]]; then
        printf '%s\\n' "$STUB_COMPOSE_ERROR" >&2
        exit 1
      fi
      echo " Container openlit-clickhouse  Running"
    fi
    exit 0
    ;;
esac
exit 0
`
  );

  // The readiness probes answer only while the stubbed stack is "up", and the
  // published ClickHouse port can be starved on its own.
  writeExecutable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
set -uo pipefail
url="\${*: -1}"
if [[ -f "$STUB_STATE_DIR/readiness-down" ]]; then
  exit 22
fi
if [[ -f "$STUB_STATE_DIR/port-down" && "$url" == *":8123"* ]]; then
  exit 22
fi
exit 0
`
  );

  // The catalog synchronization steps are not what this test governs.
  writeExecutable(join(bin, "pnpm"), "#!/usr/bin/env bash\nexit 0\n");

  return { root, codexHome, bin, state };
}

interface RunOptions {
  /** How many `compose up` calls fail with the Engine's 500. */
  readonly composeFailures?: number;
  /** The message the failing `compose up` prints. */
  readonly composeError?: string;
  /** Whether the Docker Engine answers `docker info`. */
  readonly engineResponsive?: boolean;
  /** Whether the stubbed stack reports itself ready. */
  readonly readiness?: boolean;
  /** Whether the published ClickHouse port is unreachable. */
  readonly publishedPortUnreachable?: boolean;
}

function runUp(fixture: Fixture, options: RunOptions = {}) {
  const result = spawnSync(
    "bash",
    [join(fixture.root, "scripts", "openlit", "up.sh")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
        REPO_ROOT: fixture.root,
        CODEX_HOME: fixture.codexHome,
        AUTODEV_OPENLIT_ENV_FILE: join(
          fixture.root,
          "config",
          "openlit",
          "openlit.env"
        ),
        AUTODEV_OPENLIT_COMPOSE_FILE: join(
          fixture.root,
          "config",
          "openlit",
          "docker-compose.yml"
        ),
        AUTODEV_OPENLIT_SECRET_FILE: join(
          fixture.codexHome,
          "openlit-secrets.env"
        ),
        AUTODEV_OPENLIT_LOCK_FILE: join(
          fixture.codexHome,
          "openlit-patched.lock"
        ),
        AUTODEV_OPENLIT_OTLP_KEY_FILE: join(
          fixture.codexHome,
          "openlit-otlp-api-key"
        ),
        STUB_STATE_DIR: fixture.state,
        STUB_IMAGE_ID: IMAGE_ID,
        STUB_COMPOSE_FAILURES: String(options.composeFailures ?? 0),
        STUB_COMPOSE_ERROR:
          options.composeError ?? ENGINE_TIMEOUT_COMPOSE_ERROR,
        AUTODEV_OPENLIT_COMPOSE_ATTEMPTS: "3",
        AUTODEV_OPENLIT_ENGINE_TIMEOUT_SECONDS: "2",
        AUTODEV_OPENLIT_CLICKHOUSE_TIMEOUT_SECONDS: "2",
        AUTODEV_OPENLIT_HTTP_TIMEOUT_SECONDS: "2"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    composeCalls: Number(
      readFileSync(join(fixture.state, "compose-calls"), "utf8").trim() || "0"
    )
  };
}

function withFixture(
  options: RunOptions,
  body: (fixture: Fixture, result: ReturnType<typeof runUp>) => void
): void {
  const fixture = createFixture();
  try {
    if (options.engineResponsive === false)
      writeFileSync(join(fixture.state, "engine-down"), "");
    if (options.readiness === false)
      writeFileSync(join(fixture.state, "readiness-down"), "");
    if (options.publishedPortUnreachable === true)
      writeFileSync(join(fixture.state, "port-down"), "");
    body(fixture, runUp(fixture, options));
  } finally {
    for (const directory of [
      fixture.root,
      fixture.codexHome,
      fixture.bin,
      fixture.state
    ]) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

test("the OpenLIT runner retries a Docker Engine that stops answering", () => {
  withFixture({ composeFailures: 1 }, (fixture, result) => {
    assert.equal(result.status, 0, result.output);
    assert.equal(
      result.composeCalls,
      2,
      "the runner must try again after the Engine misses a deadline"
    );
    assert.match(
      result.output,
      /the OpenLIT stack did not start; waiting for the Docker Engine and the stack to recover and retrying/u,
      "the runner must name the retry and its cause"
    );
    assert.match(result.output, /OpenLIT HTTP and ClickHouse are ready/u);
  });
});

test("the OpenLIT runner retries a dependency that was recorded unhealthy", () => {
  withFixture(
    { composeFailures: 1, composeError: UNHEALTHY_DEPENDENCY_COMPOSE_ERROR },
    (fixture, result) => {
      assert.equal(result.status, 0, result.output);
      assert.equal(
        result.composeCalls,
        2,
        "an unhealthy dependency is a timing verdict, so the runner tries again"
      );
      assert.match(result.output, /OpenLIT HTTP and ClickHouse are ready/u);
    }
  );
});

test("the OpenLIT runner decides success on readiness, not on Compose's exit code", () => {
  withFixture({ composeFailures: 5, readiness: true }, (_fixture, result) => {
    assert.equal(
      result.status,
      0,
      "a stack that serves is up even when Compose could not confirm it"
    );
    assert.match(result.output, /OpenLIT HTTP and ClickHouse are ready/u);
  });
});

test("the OpenLIT runner accepts ClickHouse answering in the container", () => {
  withFixture({ publishedPortUnreachable: true }, (_fixture, result) => {
    assert.equal(
      result.status,
      0,
      "a starved port forwarder must not fail a ClickHouse that is serving"
    );
    assert.match(result.output, /OpenLIT HTTP and ClickHouse are ready/u);
  });
});

test("the OpenLIT runner fails a Compose failure that no retry can fix", () => {
  withFixture(
    { composeFailures: 5, composeError: DETERMINISTIC_COMPOSE_ERROR },
    (_fixture, result) => {
      assert.notEqual(result.status, 0);
      assert.equal(
        result.composeCalls,
        1,
        "a deterministic Compose failure must not be retried"
      );
      assert.match(
        result.output,
        /docker compose could not start the OpenLIT stack/u
      );
    }
  );
});

test("the OpenLIT runner reports an unresponsive Engine instead of an API version", () => {
  withFixture(
    {
      composeFailures: 5,
      engineResponsive: false,
      readiness: false
    },
    (_fixture, result) => {
      assert.notEqual(result.status, 0);
      assert.match(
        result.output,
        /docker compose could not start the OpenLIT stack after \d+ attempts/u,
        "the failure must name the attempts it made"
      );
      assert.match(
        result.output,
        /the version is not the problem/u,
        "the failure must steer the reader away from the API-version hint"
      );
    }
  );
});
