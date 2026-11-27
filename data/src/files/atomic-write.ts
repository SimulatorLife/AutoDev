import { lstatSync, mkdirSync, readFileSync, type Stats } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import writeFileAtomic from "write-file-atomic";

export type AtomicWriteContent = string | Uint8Array;

export interface AtomicWriteOptions {
  /**
  The permission bits the written file must carry. Omitted, an existing file
  keeps its permissions and a new file takes the process default.
  */
  readonly mode?: number;
  /**
  Leave the file untouched when it already holds this content and mode.
  */
  readonly skipUnchanged?: boolean;
}

export class AtomicWriteDirectoryError extends Error {
  constructor(filePath: string) {
    super(`refusing to overwrite directory ${filePath}`);
    this.name = "AtomicWriteDirectoryError";
  }
}

/**
Whether the bytes on disk already are `content` at the requested mode.
*/
function holdsContent(
  stat: Stats,
  existing: Buffer,
  content: AtomicWriteContent,
  mode: number | undefined
): boolean {
  return (
    (mode === undefined || (stat.mode & 0o777) === (mode & 0o777)) &&
    existing.equals(Buffer.from(content))
  );
}

function assertNotDirectory(stat: Stats, filePath: string): void {
  if (stat.isDirectory()) throw new AtomicWriteDirectoryError(filePath);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
Replace `filePath` with `content` so a reader sees the old file or the new
one, never a partial write. The temporary file, fsync, rename and cleanup are
write-file-atomic's: its temporary names are unique per process, thread and
call, so concurrent writers never share one. Missing parent directories are
created; a directory at `filePath` is refused.
*/
export function atomicWriteSync(
  filePath: string,
  content: AtomicWriteContent,
  options: AtomicWriteOptions = {}
): void {
  try {
    const stat = lstatSync(filePath);
    assertNotDirectory(stat, filePath);
    if (
      options.skipUnchanged === true &&
      stat.isFile() &&
      holdsContent(stat, readFileSync(filePath), content, options.mode)
    )
      return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic.sync(filePath, content as string | Buffer, {
    ...(options.mode !== undefined && { mode: options.mode })
  });
}

/**
The asynchronous form of {@link atomicWriteSync}, with the same contract.
*/
export async function atomicWrite(
  filePath: string,
  content: AtomicWriteContent,
  options: AtomicWriteOptions = {}
): Promise<void> {
  try {
    const stat = await lstat(filePath);
    assertNotDirectory(stat, filePath);
    if (
      options.skipUnchanged === true &&
      stat.isFile() &&
      holdsContent(stat, await readFile(filePath), content, options.mode)
    )
      return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, content as string | Buffer, {
    ...(options.mode !== undefined && { mode: options.mode })
  });
}
