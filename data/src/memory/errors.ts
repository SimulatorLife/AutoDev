/** Row data failed structural/enum validation while hydrating a domain object. */
export class MemoryHydrationError extends Error {
  constructor(table: string, column: string, detail: string) {
    super(`Invalid ${table}.${column}: ${detail}`);
    this.name = "MemoryHydrationError";
  }
}

/** A write violated an append-only or uniqueness invariant owned by this repository. */
export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryConflictError";
  }
}

/** A memory proposal referenced provenance that does not exist in storage. */
export class MemoryProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryProvenanceError";
  }
}

/** A lifecycle event failed to match the write it was meant to accompany. */
export class MemoryLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryLifecycleError";
  }
}

/** A caller-supplied embedding was missing, empty, non-finite, or dimension-mismatched. */
export class MemoryVectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryVectorError";
  }
}
