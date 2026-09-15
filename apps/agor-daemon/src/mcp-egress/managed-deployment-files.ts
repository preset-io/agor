import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, normalize, parse } from 'node:path';

export class ManagedDeploymentError extends Error {
  constructor() {
    super('Managed MCP OAuth deployment evidence is unavailable or unsafe.');
    this.name = 'ManagedDeploymentError';
  }
}

/** No symlinks (including ancestor directories), special files, shared writes or oversized input. */
export function readManagedDeploymentFile(
  path: string,
  maxBytes: number,
  privateKey = false
): Buffer {
  let fd: number | undefined;
  try {
    if (
      !isAbsolute(path) ||
      normalize(path) !== path ||
      [...path].some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error();
    const owners = new Set([0, process.geteuid?.()]);
    let parent = dirname(path);
    for (;;) {
      const info = lstatSync(parent);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !owners.has(info.uid) ||
        (info.mode & 0o022) !== 0
      )
        throw new Error();
      if (parent === parse(parent).root) break;
      parent = dirname(parent);
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      !owners.has(before.uid) ||
      before.nlink !== 1 ||
      (before.mode & (privateKey ? 0o077 : 0o022)) !== 0 ||
      before.size < 1 ||
      before.size > maxBytes
    )
      throw new Error();
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      length += count;
      if (length > maxBytes) throw new Error();
      if (count === 0) break;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd);
    if (
      bytes.length > maxBytes ||
      bytes.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.uid !== after.uid ||
      before.mode !== after.mode ||
      // Atomic rename publication may unlink our already-open, immutable old
      // inode. That snapshot is safe; an in-place rewrite is not.
      (before.ctimeMs !== after.ctimeMs && after.nlink !== 0)
    )
      throw new Error();
    return bytes;
  } catch {
    throw new ManagedDeploymentError();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
