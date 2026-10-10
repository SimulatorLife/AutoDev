import {
  assertPlaytestObservationContract,
  type PlaytestJsonValue,
  type PlaytestObservationContract
} from "@simulatorlife/autodev-core";

const FIELD_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d{0,3})$/u;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PATH_SEGMENTS = 32;
const MAX_PROJECTED_ARRAY_INDEX = 4095;

interface PathNode {
  terminal: boolean;
  readonly children: Map<string, PathNode>;
}

function pathNode(): PathNode {
  return { terminal: false, children: new Map() };
}

function assertJsonValue(
  value: unknown,
  depth = 0
): asserts value is PlaytestJsonValue {
  if (depth > 64)
    throw new TypeError("Observation exceeds the JSON nesting bound.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) assertJsonValue(item, depth + 1);
    return;
  }
  throw new TypeError("Observation contains a value that is not JSON data.");
}

function insertPath(root: PathNode, fieldPath: string): void {
  const segments = fieldPath.split(".");
  if (
    segments.length === 0 ||
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some(
      (segment) =>
        !FIELD_SEGMENT_PATTERN.test(segment) ||
        FORBIDDEN_SEGMENTS.has(segment) ||
        (ARRAY_INDEX_PATTERN.test(segment) &&
          Number(segment) > MAX_PROJECTED_ARRAY_INDEX)
    )
  ) {
    throw new TypeError(
      `Observation field path '${fieldPath}' is unsupported.`
    );
  }
  let current = root;
  for (const segment of segments) {
    if (current.terminal) {
      throw new TypeError("Observation allowlist paths must not overlap.");
    }
    let child = current.children.get(segment);
    if (child === undefined) {
      child = pathNode();
      current.children.set(segment, child);
    }
    current = child;
  }
  if (current.terminal || current.children.size > 0) {
    throw new TypeError(
      "Observation allowlist paths must be unique and non-overlapping."
    );
  }
  current.terminal = true;
}

interface ChildValue {
  readonly found: boolean;
  readonly value: unknown;
}

function isScalarJsonValue(
  value: unknown
): value is null | boolean | number | string {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function assertVisibleFieldValue(
  value: unknown
): asserts value is PlaytestJsonValue {
  assertJsonValue(value);
  if (
    !isScalarJsonValue(value) &&
    (!Array.isArray(value) || value.some((item) => !isScalarJsonValue(item)))
  ) {
    throw new TypeError(
      "Object-valued allowlisted fields must be projected through their nested field paths."
    );
  }
}

function readChild(value: unknown, key: string): ChildValue {
  if (Array.isArray(value)) {
    if (!ARRAY_INDEX_PATTERN.test(key)) return { found: false, value: null };
    const item = value[Number(key)];
    return item === undefined
      ? { found: false, value: null }
      : { found: true, value: item };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, key)
  ) {
    return { found: false, value: null };
  }
  return { found: true, value: (value as Record<string, unknown>)[key] };
}

function leafFieldPath(tree: PathNode, currentPath: string): string {
  if (tree.terminal || tree.children.size === 0) return currentPath;
  const firstEntry = tree.children.entries().next().value;
  if (!firstEntry) return currentPath;
  const [key, child] = firstEntry;
  return leafFieldPath(child, currentPath ? `${currentPath}.${key}` : key);
}

function projectNode(
  value: unknown,
  tree: PathNode,
  path: string
): PlaytestJsonValue {
  if (tree.terminal) {
    assertVisibleFieldValue(value);
    return value;
  }
  if (Array.isArray(value)) {
    const indices = Array.from(tree.children.keys(), Number);
    const output = Array.from({ length: Math.max(...indices) + 1 }).fill(
      null
    ) as PlaytestJsonValue[];
    for (const [key, childTree] of tree.children) {
      const child = readChild(value, key);
      if (!child.found) {
        const missingPath = leafFieldPath(childTree, `${path}${key}`);
        throw new TypeError(
          `Player-visible observation field '${missingPath}' is missing.`
        );
      }
      output[Number(key)] = projectNode(
        child.value,
        childTree,
        `${path}${key}.`
      );
    }
    return output;
  }
  if (typeof value !== "object" || value === null) {
    const shapePath = path.endsWith(".") ? path.slice(0, -1) : path;
    throw new TypeError(
      `Player-visible observation field '${shapePath}' has the wrong shape.`
    );
  }
  const output: Record<string, PlaytestJsonValue> = {};
  for (const [key, childTree] of tree.children) {
    const child = readChild(value, key);
    if (!child.found) {
      const missingPath = leafFieldPath(childTree, `${path}${key}`);
      throw new TypeError(
        `Player-visible observation field '${missingPath}' is missing.`
      );
    }
    output[key] = projectNode(child.value, childTree, `${path}${key}.`);
  }
  return output;
}

/**
 * Project an adapter observation to only the fields in the game-authored
 * player-visible allowlist. An absent allowlisted field is a contract error;
 * hidden fields are never forwarded to policies, loop hashing or trace windows.
 */
export function projectPlaytestVisibleObservation(
  observation: unknown,
  contract: PlaytestObservationContract
): PlaytestJsonValue {
  assertPlaytestObservationContract(contract);
  assertJsonValue(observation);
  const allowlist = pathNode();
  for (const field of contract.fields) insertPath(allowlist, field.fieldPath);
  return projectNode(observation, allowlist, "");
}
