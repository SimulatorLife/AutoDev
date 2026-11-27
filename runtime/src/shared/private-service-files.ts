import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync
} from "node:fs";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";

function privateFileStat(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
The service owns its parent directory; refuse redirected file leaves.
*/
export function privateWrite(file: string, content: string): void {
  const stat = privateFileStat(file);
  if (
    stat &&
    (!stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid()))
  ) {
    throw new Error("Refusing non-private service file: " + file);
  }
  atomicWriteSync(file, content, { mode: 0o600, skipUnchanged: true });
  chmodSync(file, 0o600);
}

/**
Validate and read the same opened inode, without following a leaf symlink.
*/
export function privateRead(file: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    // O_NOFOLLOW refuses a symlinked leaf: it is not a private regular file.
    if (code === "ELOOP")
      throw new Error("Service file must be a private regular file: " + file);
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error("Service file must be a private regular file: " + file);
    }
    return readFileSync(descriptor, "utf8").trim();
  } finally {
    closeSync(descriptor);
  }
}

export function assertPrivateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "Service directory must be private and owned: " + directory
    );
  }
}

/**
Create (or verify) an owned service directory, tightening its mode.
*/
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "Service directory must be an owned directory, not a symlink: " +
        directory
    );
  }
  chmodSync(directory, 0o700);
}
