/**
 * Deterministic, safe primitives for moving a tenant's on-disk data in and out
 * of a portable archive. Every function takes explicit absolute roots — this
 * module never resolves configuration or decides where a tenant's files live;
 * the caller (CLI/daemon) passes the runtime-resolved tenant filesystem root
 * (`getTenantDataRoot(tenantId)`), keeping this layer agnostic of how storage is
 * mounted or transported.
 *
 * Safety contract:
 *
 *   - The tree walk never follows symlinks. An internal symbolic link is recorded
 *     as its own entry with its target normalised to a canonical link-relative
 *     POSIX path (so an absolute source-internal target round-trips and restores
 *     safely under any destination root); a link whose target escapes the tenant
 *     root is skipped, not archived. Directory symlinks are not descended, which
 *     also prevents cycles.
 *   - Regular-file reads (hash and copy) open with `O_NOFOLLOW` and then prove
 *     the opened inode's canonical path is inside the tenant root. A file whose
 *     terminal component OR an intermediate directory was swapped to a symlink so
 *     the read would resolve outside the root fails closed — the export aborts
 *     rather than archiving foreign bytes.
 *   - Every archived path is a POSIX relative path validated to stay within the
 *     root (no absolute paths, no `..` traversal, no NUL bytes).
 *   - On restore, files are written into a staging directory and the finished
 *     tree is published to its destination with a single atomic rename; a symlink
 *     whose target would escape the destination root is rejected.
 *   - Special files (sockets, FIFOs, devices) are not tenant data bytes and are
 *     skipped, counted, and reported rather than copied.
 *
 * Entries are always returned in a stable, byte-order-sorted order so an export
 * of unchanged data is reproducible.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, constants as fsConstants, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Kind of filesystem entry captured in an archive. */
export type TenantFilesystemEntryType = 'file' | 'directory' | 'symlink';

/** A single archived filesystem entry. Contains no file contents. */
export interface TenantFilesystemEntry {
  /** POSIX relative path from the tenant root. Always safe (validated). */
  path: string;
  type: TenantFilesystemEntryType;
  /** Byte size for regular files; 0 otherwise. */
  size: number;
  /** SHA-256 hex of file contents for regular files; absent otherwise. */
  sha256?: string;
  /**
   * Canonical link-relative POSIX target for symlinks; absent otherwise. Always
   * relative to the link's own directory and proven to stay within the tenant
   * root, so it restores correctly under any destination root.
   */
  linkTarget?: string;
  /**
   * Ordinary POSIX permission bits (rwxrwxrwx, lower 9) preserved for restore.
   * setuid/setgid/sticky are never carried across a portable archive.
   */
  mode: number;
}

/** Bounded, contents-free summary of a tenant's filesystem footprint. */
export interface TenantFilesystemInventory {
  /** Whether the tenant root exists on disk. */
  present: boolean;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  /** Total bytes across regular files. */
  totalBytes: number;
  /** Count of special files (socket/FIFO/device) skipped as non-data. */
  skippedSpecialCount: number;
  /** Count of symlinks whose target escapes the tenant root. */
  unsafeSymlinkCount: number;
}

/**
 * Structural equality of two filesystem entries describing the SAME path:
 * identical type, size, permission mode, content hash, and link target. Path is
 * intentionally not compared — callers key entries by path and own how they
 * aggregate mismatches into evidence. Shared by import (destination-matches
 * classification) and verify (per-path comparison).
 */
export function tenantFilesystemEntriesEqual(
  a: TenantFilesystemEntry,
  b: TenantFilesystemEntry
): boolean {
  return (
    a.type === b.type &&
    a.size === b.size &&
    a.mode === b.mode &&
    (a.sha256 ?? null) === (b.sha256 ?? null) &&
    (a.linkTarget ?? null) === (b.linkTarget ?? null)
  );
}

/** Thrown when an archive path or link is unsafe (traversal, absolute, escape). */
export class UnsafeArchivePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeArchivePathError';
  }
}

const MAX_TRAVERSAL_DEPTH = 128;

/**
 * Validate that a stored archive path is a safe POSIX relative path: non-empty,
 * not absolute, free of `..` segments, `.` segments, and NUL bytes. Returns the
 * normalised path.
 */
export function assertSafeRelativePath(candidate: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new UnsafeArchivePathError('Archive path must be a non-empty string');
  }
  if (candidate.includes('\0')) {
    throw new UnsafeArchivePathError('Archive path must not contain NUL bytes');
  }
  if (candidate.startsWith('/') || candidate.startsWith('\\')) {
    throw new UnsafeArchivePathError(`Archive path must be relative: ${candidate}`);
  }
  // Reject Windows drive-letter absolutes defensively.
  if (/^[a-zA-Z]:/.test(candidate)) {
    throw new UnsafeArchivePathError(
      `Archive path must not be a drive-absolute path: ${candidate}`
    );
  }
  const segments = candidate.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      throw new UnsafeArchivePathError(`Archive path has an empty or "." segment: ${candidate}`);
    }
    if (segment === '..') {
      throw new UnsafeArchivePathError(`Archive path must not traverse with "..": ${candidate}`);
    }
  }
  return segments.join('/');
}

/**
 * Resolve a validated relative path against a root and confirm the result stays
 * within the root even after normalisation. Returns the absolute path.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  const safe = assertSafeRelativePath(relativePath);
  const absolute = resolve(root, safe.split('/').join(sep));
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || resolve(rel) === rel) {
    throw new UnsafeArchivePathError(`Archive path escapes the destination root: ${relativePath}`);
  }
  return absolute;
}

/**
 * Prove a stored symlink's canonical link-relative target stays within the
 * virtual tenant root, using ONLY the entry's own relative path and target — no
 * filesystem access. The link lives at `entryPath`; its target is resolved
 * relative to the link's parent directory in POSIX virtual space and must not be
 * absolute nor climb above the root.
 *
 * This is the pure, root-independent counterpart to staging's real-root check.
 * Because it needs no live root, the importer can invoke it BEFORE any database
 * write to reject a crafted archive whose symlink escapes — which is what keeps
 * the "rejected before any data was modified" guarantee true for every archive
 * category, not just those the terminal staging step happens to reach.
 */
export function assertSymlinkTargetWithinRoot(entryPath: string, linkTarget: string): void {
  if (typeof linkTarget !== 'string' || linkTarget.length === 0 || linkTarget.includes('\0')) {
    throw new UnsafeArchivePathError(`Archive symlink ${entryPath} has an invalid target`);
  }
  // An absolute target can never be re-rooted safely on restore.
  if (linkTarget.startsWith('/') || linkTarget.startsWith('\\') || /^[a-zA-Z]:/.test(linkTarget)) {
    throw new UnsafeArchivePathError(
      `Archive symlink ${entryPath} has an absolute target: ${linkTarget}`
    );
  }
  const linkParent = posix.dirname(entryPath);
  const resolved = posix.normalize(
    linkParent === '.' ? linkTarget : posix.join(linkParent, linkTarget)
  );
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
    throw new UnsafeArchivePathError(
      `Archive symlink ${entryPath} targets a path outside the tenant root: ${linkTarget}`
    );
  }
}

/**
 * Prove that the inode behind an already-open descriptor lives inside
 * `allowedRoot` (the tenant filesystem root's canonical path), and refuse
 * otherwise. This is what closes the intermediate-directory symlink swap that
 * `O_NOFOLLOW` alone cannot: `O_NOFOLLOW` guards only the TERMINAL component, so
 * an adversary who swaps an ancestor DIRECTORY to a symlink between the walk and
 * the read can make `open(root/ancestor/file)` resolve to an inode OUTSIDE the
 * tenant root. We resolve the canonical path of the descriptor we actually hold
 * open and require it to be within `allowedRoot` — the check runs against the
 * SAME fd we read from, so there is no re-open TOCTOU.
 *
 * Linux (primary target): read `/proc/self/fd/<fd>`, which names the inode the
 * descriptor points at regardless of how the path was resolved. Portable
 * fallback when `/proc` is absent (`ENOENT`): resolve the path with `realpath`
 * and require its dev+ino to equal the open descriptor's `fstat` dev+ino, so the
 * canonical path names the very inode we hold rather than a swapped one. Either
 * way, a canonical location outside `allowedRoot` fails closed.
 */
async function assertOpenedInodeWithinRoot(
  handle: FileHandle,
  fstatInfo: Stats,
  entryAbsolutePath: string,
  allowedRoot: string
): Promise<void> {
  let canonical: string;
  try {
    canonical = await readlink(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // `/proc` unavailable (non-Linux or restricted): resolve the path and prove
    // it names the very inode we hold open, not one swapped in behind us.
    canonical = await realpath(entryAbsolutePath);
    const viaPath = await lstat(canonical);
    if (viaPath.dev !== fstatInfo.dev || viaPath.ino !== fstatInfo.ino) {
      throw new UnsafeArchivePathError(
        `Refusing to read a file whose canonical path is not the opened inode: ${entryAbsolutePath}`
      );
    }
  }
  const rel = relative(allowedRoot, canonical);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UnsafeArchivePathError(
      `Refusing to read a file that resolves outside the tenant root: ${entryAbsolutePath}`
    );
  }
}

/**
 * Open a path as a regular file WITHOUT following a terminal symlink
 * (`O_NOFOLLOW`), `fstat` the descriptor to confirm it really is a regular file,
 * and prove the opened inode's canonical path is inside `allowedRoot` (the
 * canonical tenant filesystem root). This closes two attacks at once:
 *
 *   - Terminal swap: if the path was replaced by a symlink after the walk saw a
 *     regular file, `open` fails with `ELOOP` and we refuse it.
 *   - Intermediate-directory swap: if an ancestor directory was replaced by a
 *     symlink so the path resolves to an inode OUTSIDE the tenant root, the
 *     `allowedRoot` containment check (see `assertOpenedInodeWithinRoot`) fails
 *     closed and we refuse rather than reading the foreign bytes.
 *
 * The export therefore ABORTS on such a swap instead of archiving out-of-root
 * bytes; it is prevention, not detection-after-the-fact. The returned handle
 * must be closed by the caller.
 */
async function openRegularFileNoFollow(
  absolutePath: string,
  allowedRoot: string
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new UnsafeArchivePathError(
        `Refusing to follow a symlink at a regular-file path: ${absolutePath}`
      );
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new UnsafeArchivePathError(`Refusing to read a non-regular file: ${absolutePath}`);
    }
    await assertOpenedInodeWithinRoot(handle, info, absolutePath, allowedRoot);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  return handle;
}

async function sha256File(absolutePath: string, allowedRoot: string): Promise<string> {
  const handle = await openRegularFileNoFollow(absolutePath, allowedRoot);
  try {
    const hash = createHash('sha256');
    await pipeline(handle.createReadStream(), hash);
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Copy a regular file into `destinationPath` through the symlink-safe,
 * root-containment-checked open (see {@link openRegularFileNoFollow}): an
 * out-of-root source is refused, not copied. Exported for unit coverage of the
 * copy path's refusals.
 */
export async function copyRegularFileNoFollow(
  sourcePath: string,
  destinationPath: string,
  allowedRoot: string
): Promise<void> {
  const handle = await openRegularFileNoFollow(sourcePath, allowedRoot);
  try {
    await pipeline(handle.createReadStream(), createWriteStream(destinationPath));
  } finally {
    await handle.close().catch(() => {});
  }
}

function permissionBits(mode: number): number {
  // Keep ONLY the ordinary rwxrwxrwx bits (lower 9). The setuid/setgid/sticky
  // bits are deliberately dropped: a portable archive must never carry
  // privilege-escalation bits across a trust boundary, and re-applying an
  // attacker-influenced setuid bit on restore would be a local escalation
  // primitive. Ownership is likewise never preserved — that is a deployment
  // concern. Strict manifest validation additionally REJECTS (rather than
  // silently normalises) any entry whose stored mode carries a special bit.
  return mode & 0o777;
}

interface WalkAccumulator {
  entries: TenantFilesystemEntry[];
  skippedSpecialCount: number;
  unsafeSymlinkCount: number;
}

/**
 * If `linkTarget` (resolved relative to the link's own directory) stays within
 * `root`, return a canonical POSIX target RELATIVE TO THE LINK'S DIRECTORY that
 * points at the same in-root location; otherwise return null.
 *
 * Normalising to a link-relative target is what makes an internal link portable.
 * An absolute source-internal target (e.g. `/tenants/<id>/repos/x`) is accepted
 * at export because it resolves inside the source root, but on restore it would
 * be validated against a DIFFERENT staging/destination root and rejected — the
 * round-trip asymmetry. Rewriting every accepted internal target to a
 * link-relative path preserves the same in-root topology under any root, so the
 * link stages and restores safely, while a target escaping the root still
 * returns null (skipped, never archived).
 */
function internalSymlinkRelativeTarget(
  root: string,
  linkAbsoluteDir: string,
  linkTarget: string
): string | null {
  const targetAbsolute = resolve(linkAbsoluteDir, linkTarget);
  const relFromRoot = relative(root, targetAbsolute);
  if (relFromRoot === '' || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    return null;
  }
  return relative(linkAbsoluteDir, targetAbsolute).split(sep).join('/');
}

async function walkDirectory(
  root: string,
  allowedRoot: string,
  absoluteDir: string,
  relativeDir: string,
  depth: number,
  acc: WalkAccumulator
): Promise<void> {
  if (depth > MAX_TRAVERSAL_DEPTH) {
    throw new UnsafeArchivePathError(
      `Tenant filesystem tree exceeds maximum depth ${MAX_TRAVERSAL_DEPTH} at ${relativeDir || '.'}`
    );
  }
  const dirents = await readdir(absoluteDir, { withFileTypes: true });
  // Sort by name for deterministic ordering.
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const dirent of dirents) {
    const absolutePath = join(absoluteDir, dirent.name);
    const relPath = relativeDir ? posix.join(relativeDir, dirent.name) : dirent.name;
    // lstat so we classify the link itself, never its target.
    const info = await lstat(absolutePath);

    if (info.isSymbolicLink()) {
      const rawTarget = await readlink(absolutePath);
      // Normalise an accepted internal target to a canonical link-relative path
      // so it round-trips and restores under any root; a link pointing outside
      // the tenant root is not tenant data and could exfiltrate unrelated files
      // on restore — record and skip.
      const linkTarget = internalSymlinkRelativeTarget(root, absoluteDir, rawTarget);
      if (linkTarget === null) {
        acc.unsafeSymlinkCount += 1;
        continue;
      }
      acc.entries.push({
        path: relPath,
        type: 'symlink',
        size: 0,
        linkTarget,
        mode: permissionBits(info.mode),
      });
      continue;
    }

    if (info.isDirectory()) {
      acc.entries.push({
        path: relPath,
        type: 'directory',
        size: 0,
        mode: permissionBits(info.mode),
      });
      await walkDirectory(root, allowedRoot, absolutePath, relPath, depth + 1, acc);
      continue;
    }

    if (info.isFile()) {
      acc.entries.push({
        path: relPath,
        type: 'file',
        size: info.size,
        sha256: await sha256File(absolutePath, allowedRoot),
        mode: permissionBits(info.mode),
      });
      continue;
    }

    // Socket / FIFO / device — not tenant data bytes.
    acc.skippedSpecialCount += 1;
  }
}

async function rootExists(root: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Permission, I/O, and malformed-path failures are not absence proof.
    throw error;
  }
  // lstat, not stat: a symlinked root must never be followed. Following it would
  // let a link resolve the "tenant root" to an unrelated tree and export or
  // publish over it. The walk claims "never follows symlinks" — enforce that at
  // the root too.
  if (info.isSymbolicLink()) {
    throw new UnsafeArchivePathError(`Refusing to operate on a symlinked tenant root: ${root}`);
  }
  return info.isDirectory();
}

/**
 * Walk a tenant filesystem root into a deterministic, contents-free list of
 * entries (files carry their SHA-256). Returns an empty list when the root is
 * absent. Never follows symlinks.
 */
export async function walkTenantFilesystemTree(root: string): Promise<{
  entries: TenantFilesystemEntry[];
  skippedSpecialCount: number;
  unsafeSymlinkCount: number;
}> {
  if (!(await rootExists(root))) {
    return { entries: [], skippedSpecialCount: 0, unsafeSymlinkCount: 0 };
  }
  // Canonicalise the root once. Every file we open must resolve to an inode
  // inside this path, or the read is refused (fail closed on an ancestor-symlink
  // swap that would route a read outside the tenant root).
  const allowedRoot = await realpath(root);
  const acc: WalkAccumulator = { entries: [], skippedSpecialCount: 0, unsafeSymlinkCount: 0 };
  await walkDirectory(root, allowedRoot, root, '', 0, acc);
  acc.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    entries: acc.entries,
    skippedSpecialCount: acc.skippedSpecialCount,
    unsafeSymlinkCount: acc.unsafeSymlinkCount,
  };
}

/**
 * Produce a bounded, contents-free inventory of a tenant filesystem root. Safe
 * to print: only counts and byte totals, never names or contents.
 */
export async function summarizeTenantFilesystem(root: string): Promise<TenantFilesystemInventory> {
  const present = await rootExists(root);
  if (!present) {
    return {
      present: false,
      fileCount: 0,
      directoryCount: 0,
      symlinkCount: 0,
      totalBytes: 0,
      skippedSpecialCount: 0,
      unsafeSymlinkCount: 0,
    };
  }
  const { entries, skippedSpecialCount, unsafeSymlinkCount } = await walkTenantFilesystemTree(root);
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.type === 'file') {
      fileCount += 1;
      totalBytes += entry.size;
    } else if (entry.type === 'directory') {
      directoryCount += 1;
    } else {
      symlinkCount += 1;
    }
  }
  return {
    present: true,
    fileCount,
    directoryCount,
    symlinkCount,
    totalBytes,
    skippedSpecialCount,
    unsafeSymlinkCount,
  };
}

/**
 * Owner-accessible temporary mode a directory is created with while its contents
 * are materialised. Its archived mode is applied only AFTER every child exists
 * (see {@link materializeEntries}), so an exported read-only or unreadable
 * directory (0o500 / 0o000) never blocks a non-root process from writing the
 * files that belong inside it.
 */
const DIRECTORY_STAGING_MODE = 0o700;

/**
 * Materialise a validated, path-sorted list of filesystem entries under
 * `targetRoot`, deferring directory permission modes until every child exists.
 *
 * Directories are created with an owner-accessible temporary mode; files and
 * symlinks are written through caller-supplied handlers (which differ by
 * direction — a root-contained copy on export, a plain copy plus target
 * re-validation on restore). Only once the whole tree is present are the
 * archived directory modes applied, DEEPEST-FIRST, so a restrictive parent mode
 * (0o500/0o000) is never set before its own children are finalised — otherwise a
 * non-root process could not chmod, or even reach, the contents underneath it.
 * Files receive their archived (special-bit-stripped) mode as they are written,
 * while their parent is still writable.
 */
async function materializeEntries(
  entries: TenantFilesystemEntry[],
  targetRoot: string,
  handlers: {
    writeFile: (entry: TenantFilesystemEntry, destination: string) => Promise<void>;
    writeSymlink: (entry: TenantFilesystemEntry, destination: string) => Promise<void>;
  }
): Promise<void> {
  const deferredDirectoryModes: Array<{ absolute: string; mode: number; depth: number }> = [];
  for (const entry of entries) {
    const destination = resolveWithinRoot(targetRoot, entry.path);
    if (entry.type === 'directory') {
      await mkdir(destination, { recursive: true });
      await chmod(destination, DIRECTORY_STAGING_MODE);
      deferredDirectoryModes.push({
        absolute: destination,
        mode: permissionBits(entry.mode),
        depth: entry.path.split('/').length,
      });
    } else if (entry.type === 'symlink') {
      await mkdir(dirname(destination), { recursive: true });
      await handlers.writeSymlink(entry, destination);
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await handlers.writeFile(entry, destination);
      await chmod(destination, permissionBits(entry.mode));
    }
  }
  deferredDirectoryModes.sort((a, b) => b.depth - a.depth);
  for (const directory of deferredDirectoryModes) {
    await chmod(directory.absolute, directory.mode);
  }
}

/**
 * Copy a tenant filesystem tree into a bundle's `files/` directory, preserving
 * structure, ordinary permissions, and internal symlinks. Returns the walk
 * result so the caller can record entries in the manifest.
 */
export async function copyTenantFilesystemInto(
  root: string,
  destinationFilesDir: string
): Promise<{
  entries: TenantFilesystemEntry[];
  skippedSpecialCount: number;
  unsafeSymlinkCount: number;
}> {
  const walk = await walkTenantFilesystemTree(root);
  await mkdir(destinationFilesDir, { recursive: true });
  // Canonical root once, so each opened file is proven to resolve inside it.
  // Skip resolution when there is nothing to read (absent/empty root would make
  // `realpath` throw).
  const allowedRoot = walk.entries.some((entry) => entry.type === 'file')
    ? await realpath(root)
    : root;
  await materializeEntries(walk.entries, destinationFilesDir, {
    // Symlink-safe, root-contained read (see openRegularFileNoFollow): an
    // out-of-root source fails the export closed instead of archiving it.
    writeFile: (entry, destination) =>
      copyRegularFileNoFollow(
        join(root, entry.path.split('/').join(sep)),
        destination,
        allowedRoot
      ),
    writeSymlink: (entry, destination) => symlink(entry.linkTarget as string, destination),
  });
  return walk;
}

/**
 * Materialise a validated set of archive entries into a staging directory,
 * reading file bytes from the bundle's `files/` directory. Every path (entry and
 * symlink target) is re-validated to stay within the staging root, and directory
 * modes are applied only after contents exist. This does not touch the live
 * destination — publication is a separate atomic step.
 */
export async function stageTenantFilesystem(
  entries: TenantFilesystemEntry[],
  bundleFilesDir: string,
  stagingRoot: string
): Promise<void> {
  await mkdir(stagingRoot, { recursive: true });
  await materializeEntries(entries, stagingRoot, {
    writeFile: (entry, destination) =>
      copyFile(resolveWithinRoot(bundleFilesDir, entry.path), destination),
    writeSymlink: async (entry, destination) => {
      const linkTarget = entry.linkTarget ?? '';
      // Last-line defense: reject a link whose stored target would escape the
      // destination root (the importer already validates every target up front,
      // before any database write — see assertSymlinkTargetWithinRoot).
      assertSymlinkTargetWithinRoot(entry.path, linkTarget);
      await symlink(linkTarget, destination);
    },
  });
}

async function isDirectoryEmpty(path: string): Promise<boolean> {
  const dirents = await readdir(path);
  return dirents.length === 0;
}

/**
 * Publish a fully-staged tree to its final destination with a single atomic
 * rename. The destination must be absent or an empty directory. The staging root
 * must sit on the same filesystem as the destination for the rename to be atomic
 * (callers stage as a sibling of the destination).
 */
export async function publishTenantFilesystemAtomically(
  stagingRoot: string,
  destinationRoot: string
): Promise<void> {
  if (await rootExists(destinationRoot)) {
    if (!(await isDirectoryEmpty(destinationRoot))) {
      throw new UnsafeArchivePathError(
        `Refusing to publish: destination tenant root is not empty: ${destinationRoot}`
      );
    }
    // Remove the empty placeholder so rename can claim the name atomically.
    await rm(destinationRoot, { recursive: true, force: true });
  }
  await mkdir(dirname(destinationRoot), { recursive: true });
  await rename(stagingRoot, destinationRoot);
}

/**
 * Safely and idempotently delete a tenant filesystem root and everything under
 * it. Refuses to delete a path that is not genuinely tenant-scoped: the resolved
 * root must be a strict descendant of `allowedBaseRoot` (the configured tenants
 * base folder), never the base itself. A missing root is a no-op success.
 */
export async function deleteTenantFilesystemTree(
  tenantRoot: string,
  allowedBaseRoot: string
): Promise<{ deleted: boolean }> {
  // lstat BEFORE realpath: realpath would resolve a symlinked root to whatever
  // it points at, and the containment check below would then be evaluated
  // against that resolved tree — potentially deleting data outside the tenants
  // base. Refuse a symlinked root and delete nothing. A missing root is an
  // idempotent no-op success.
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(tenantRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deleted: false };
    }
    // Fail closed: an unreadable path must never be reported as already absent.
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new UnsafeArchivePathError(
      `Refusing to delete tenant filesystem: ${tenantRoot} is a symlink`
    );
  }
  if (!info.isDirectory()) {
    return { deleted: false };
  }
  const resolvedBase = await realpath(allowedBaseRoot);
  const resolvedRoot = await realpath(tenantRoot);
  const rel = relative(resolvedBase, resolvedRoot);
  if (rel === '' || rel.startsWith('..') || resolve(rel) === rel) {
    throw new UnsafeArchivePathError(
      `Refusing to delete tenant filesystem: ${tenantRoot} is not inside the tenants base ${allowedBaseRoot}`
    );
  }
  await rm(resolvedRoot, { recursive: true, force: true });
  return { deleted: true };
}
