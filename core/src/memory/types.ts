export type MemoryConnectorType =
  | "local"
  | "sqlite"
  | "chroma"
  | "pgvector";

export interface MemoryRecord {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
}

export interface MemoryQuery {
  readonly query: string;
  readonly limit?: number;
  readonly filters?: Record<string, unknown>;
}
