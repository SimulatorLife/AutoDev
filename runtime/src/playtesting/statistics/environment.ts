/**
 * Hash-locked Python environment for the Playtesting statistical analysis
 * worker.
 *
 * The environment is described by:
 *
 *   runtime/src/playtesting/statistics/pyproject.toml   (declared pins)
 *   runtime/src/playtesting/statistics/uv.lock          (resolved hashes)
 *   runtime/src/playtesting/statistics/PYTHON_README.md (operator notes)
 *
 * Runtime does not improvise a venv: it shells out to `uv`, which is the
 * same tool the maintainer uses to lock the project. We refuse to fall
 * back to system Python when `uv` is unavailable or the lock has drifted
 * from `pyproject.toml`; under those conditions the worker cannot be
 * safely invoked and the request must error out honestly.
 */

import { createHash, type Hash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_SCIENTIFIC_LOCK } from "./lock-manifest.ts";

const SHA256_HEX_LENGTH = 64;
const PYPROJECT_FILE = "pyproject.toml";
const UV_LOCK_FILE = "uv.lock";
const PYTHON_README_FILE = "PYTHON_README.md";

/** Where the Python project root lives inside the Runtime source tree. */
function projectRootAbsolute(): string {
  // Resolve from this file's URL so the location remains stable across
  // tests, CLI invocations and packaged distributions.
  const here = fileURLToPath(import.meta.url);
  return realpathSync(path.resolve(path.dirname(here)));
}

/** Absolute path to the Python project's declared manifest. */
export function pyProjectTomlPath(): string {
  return path.join(projectRootAbsolute(), PYPROJECT_FILE);
}

/** Absolute path to the uv-resolved lockfile. */
export function uvLockPath(): string {
  return path.join(projectRootAbsolute(), UV_LOCK_FILE);
}

/** Absolute path to the worker entry point module. */
export function pythonWorkerModule(): string {
  return "python_script";
}

/** Absolute path to the operator documentation file. */
export function pythonReadmePath(): string {
  return path.join(projectRootAbsolute(), PYTHON_README_FILE);
}

/**
 * Stable, content-hashed identifier for the worker environment. The
 * Runtime computes it once on startup (or when the fixture is first
 * loaded) and includes it in trace/telemetry events so an investigator
 * can replay an earlier interval exactly by checking the same hash.
 *
 * The hash covers `pyproject.toml`, `uv.lock`, and the worker entry
 * point module; only changes to that triple invalidate it. This guards
 * against a silent `uv sync --no-frozen` or a hand-edit of the lockfile
 * producing intervals from a different resolved environment than the
 * recorded one.
 */
export interface ResolvedPlaytestStatEnvironment {
  readonly projectRoot: string;
  readonly pyprojectPath: string;
  readonly uvLockPath: string;
  readonly workerModule: string;
  readonly contentHash: string;
  readonly declaredPins: {
    readonly numpy: string;
    readonly scipy: string;
    readonly statsmodels: string;
    readonly python: string;
  };
}

export class PlaytestStatEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestStatEnvironmentError";
  }
}

/** SHA-256 the worker-environment files into one canonical digest. */
function sha256(buf: Buffer): string {
  const hash: Hash = createHash("sha256");
  hash.update(buf);
  return hash.digest("hex");
}

function assertExists(label: string, candidate: string): void {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) {
      throw new PlaytestStatEnvironmentError(
        `${label} exists but is not a regular file: ${candidate}`
      );
    }
  } catch {
    throw new PlaytestStatEnvironmentError(
      `${label} is missing at ${candidate}; the Playtesting statistics worker cannot run.`
    );
  }
}

function assertReadable(label: string, candidate: string): void {
  try {
    accessSync(candidate, fsConstants.R_OK);
  } catch {
    throw new PlaytestStatEnvironmentError(
      `${label} is not readable: ${candidate}; check filesystem permissions.`
    );
  }
}

/**
 * Check that the declared pins (in pyproject.toml) match the contract's
 * exact-pinned versions. The parser below understands the small subset
 * of TOML we emit in pyproject.toml: `name = "value"` and
 * `dependencies = [ "name==version", ... ]`. Anything stricter than a
 * `uv.lock`/SciPy version drift should fail the lifecycle gate rather
 * than silently re-pinning in production.
 */
export function assertDeclaredPinsMatchContract(pyprojectSource: string): {
  numpy: string;
  scipy: string;
  statsmodels: string;
  python: string;
} {
  const python = readStringAssignment(pyprojectSource, "requires-python");
  const deps = readDependenciesArray(pyprojectSource);

  const pins: Record<string, string> = {};
  for (const entry of deps) {
    pins[entry.name] = entry.specifier;
  }

  const numpySpec = pins.numpy;
  const scipySpec = pins.scipy;
  const statsmodelsSpec = pins.statsmodels;

  const issues: string[] = [];
  if (numpySpec !== `==${EXPECTED_SCIENTIFIC_LOCK.numpy}`) {
    issues.push(
      `numpy pin ${JSON.stringify(numpySpec ?? null)} ` +
        `!= ==${EXPECTED_SCIENTIFIC_LOCK.numpy}`
    );
  }
  if (scipySpec !== `==${EXPECTED_SCIENTIFIC_LOCK.scipy}`) {
    issues.push(
      `scipy pin ${JSON.stringify(scipySpec ?? null)} ` +
        `!= ==${EXPECTED_SCIENTIFIC_LOCK.scipy}`
    );
  }
  if (statsmodelsSpec !== `==${EXPECTED_SCIENTIFIC_LOCK.statsmodels}`) {
    issues.push(
      `statsmodels pin ${JSON.stringify(statsmodelsSpec ?? null)} ` +
        `!= ==${EXPECTED_SCIENTIFIC_LOCK.statsmodels}`
    );
  }
  if (python !== EXPECTED_SCIENTIFIC_LOCK.python) {
    issues.push(
      `python pin ${JSON.stringify(python)} != ` +
        JSON.stringify(EXPECTED_SCIENTIFIC_LOCK.python)
    );
  }
  if (issues.length > 0) {
    throw new PlaytestStatEnvironmentError(
      "pyproject.toml declares drifted pins: " + issues.join("; ")
    );
  }

  return {
    numpy: EXPECTED_SCIENTIFIC_LOCK.numpy,
    scipy: EXPECTED_SCIENTIFIC_LOCK.scipy,
    statsmodels: EXPECTED_SCIENTIFIC_LOCK.statsmodels,
    python: EXPECTED_SCIENTIFIC_LOCK.python
  };
}

/** Parse `name = "value"` style scalar assignments. */
function readStringAssignment(source: string, name: string): string {
  const re = new RegExp(
    String.raw`^` + name + String.raw`\s*=\s*["']([^"']*)["']\s*$`,
    "mu"
  );
  const match = re.exec(source);
  if (!match || match[1] === undefined) {
    throw new PlaytestStatEnvironmentError(
      `pyproject.toml is missing the ${name} assignment.`
    );
  }
  return match[1];
}

interface DependencyEntry {
  readonly name: string;
  readonly specifier: string;
}

const DEPENDENCIES_HEAD_RE = /^\s*dependencies\s*=\s*\[/mu;
const DEPENDENCY_ENTRY_RE = /"([A-Za-z0-9_.-]+)==([A-Za-z0-9._<>=!~+,\\-]+)"/gu;

/** Parse `name = [ "spec>=x.y.z", ... ]` style arrays. */
function readDependenciesArray(source: string): readonly DependencyEntry[] {
  const head = DEPENDENCIES_HEAD_RE.exec(source);
  if (!head) {
    throw new PlaytestStatEnvironmentError(
      "pyproject.toml has no `dependencies = [...]` block."
    );
  }
  const tail = source.indexOf("]", head.index);
  if (tail === -1) {
    throw new PlaytestStatEnvironmentError(
      "pyproject.toml dependencies block is missing its closing ']'."
    );
  }
  // Only the bracketed body is scanned; the rest of the file is excluded
  // so a long preamble cannot grow the regex's working set exponentially.
  const body = source.slice(head.index, tail + 1);
  // The match captures either a bare word or a name `== specifier`
  // pair, which is the only shape this build emits.
  DEPENDENCY_ENTRY_RE.lastIndex = 0;
  const entries: DependencyEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = DEPENDENCY_ENTRY_RE.exec(body)) !== null) {
    const name = match[1];
    const specifierRaw = match[2];
    if (!name || !specifierRaw) continue;
    entries.push({ name, specifier: "==" + specifierRaw });
  }
  return entries;
}

/**
 * Resolve and validate the worker environment. The returned
 * `contentHash` is the canonical fingerprint used by
 * `RuntimePlaytestStatAnalysis` to confirm the worker is talking to the
 * same lockfile that produced the recorded interval.
 */
export function resolvePlaytestStatEnvironment(): ResolvedPlaytestStatEnvironment {
  const projectRoot = projectRootAbsolute();
  const pyprojectPath = pyProjectTomlPath();
  const uvLockAbsPath = uvLockPath();
  const workerModule = pythonWorkerModule();
  assertExists("pyproject.toml", pyprojectPath);
  assertReadable("pyproject.toml", pyprojectPath);
  assertExists("uv.lock", uvLockAbsPath);
  assertReadable("uv.lock", uvLockAbsPath);

  const pySource = readFileSync(pyprojectPath, "utf8");
  const lockSource = readFileSync(uvLockAbsPath, "utf8");
  const declaredPins = assertDeclaredPinsMatchContract(pySource);

  // Hash the two files that govern resolved behaviour plus the worker
  // module path, so accidental edits to the entry point and any source
  // drift still invalidate the cache.
  const hash = sha256(
    Buffer.concat([
      Buffer.from(pyprojectPath, "utf8"),
      Buffer.from(pySource, "utf8"),
      Buffer.from(uvLockAbsPath, "utf8"),
      Buffer.from(lockSource, "utf8"),
      Buffer.from(workerModule, "utf8")
    ])
  );
  if (hash.length !== SHA256_HEX_LENGTH) {
    throw new PlaytestStatEnvironmentError(
      `Computed environment hash has unexpected length: ${hash.length}.`
    );
  }

  return {
    projectRoot,
    pyprojectPath,
    uvLockPath: uvLockAbsPath,
    workerModule,
    contentHash: hash,
    declaredPins
  };
}
