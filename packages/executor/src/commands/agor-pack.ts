/**
 * Teammate pack (.agorpack) filesystem legs. The daemon never touches branch
 * or branch-home files, so it asks the executor to:
 *
 * - `branch.pack.collect`: zip the branch's unpushed git history (a bundle),
 *   uncommitted/untracked files, and allow-listed Claude home files into a
 *   pack fragment and stream it to the daemon;
 * - `branch.pack.materialize`: fetch a staged pack, and write one teammate's
 *   history, files, and Claude memory into a freshly provisioned branch.
 *
 * Every path is validated with the pack's own entry rules before any read or
 * write, writes stay inside the branch (or its Claude home) without following
 * symlinks, and secret-shaped text aborts a collection.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AGOR_PACK_FRAGMENT_KEY,
  AgorPackReader,
  AgorPackWriter,
  assertNoSecrets,
  claudeProjectSlug,
  isAllowedClaudeHomePath,
  isPortableWorktreePath,
  renameClaudeProjectPath,
  teammatePackPath,
} from '@agor/core/agor-pack';
import { fileByteSource } from '@agor/core/agor-pack/file-source';
import { AGOR_PACK, type AgorPackGitState, agorPackGitStateSchema } from '@agor/core/types';
import {
  applyPackBundle,
  createPackBundle,
  readPackWorkingTreeState,
  resetToPackCommit,
} from '@agor/git';
import type {
  BranchPackCollectPayload,
  BranchPackMaterializePayload,
  ExecutorResult,
} from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { resolveExecutorBranch, resolvePathInsideBranch } from './branch-filesystem.js';
import type { CommandOptions } from './index.js';

const CLAUDE_DIR = 'claude';

function assertBranchHome(params: {
  branchHome: string;
  tenantDataRoot: string;
  branchId: string;
}): string {
  if (params.branchHome !== resolve(params.tenantDataRoot, 'branch-homes', params.branchId)) {
    throw new Error('Branch SDK home identity mismatch');
  }
  return join(params.branchHome, CLAUDE_DIR);
}

/** Text files are scanned for secrets; binary files (NUL in the head) are not. */
function looksLikeText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8192).includes(0);
}

async function listClaudeHomeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      // Dirent types come from lstat semantics: symlinks are never followed.
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const rel = relative(root, absolute).split(sep).join('/');
        if (isAllowedClaudeHomePath(rel)) files.push(rel);
      }
    }
  };
  await walk(root);
  return files.sort();
}

function failure(code: string, error: unknown): ExecutorResult {
  return {
    success: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
  };
}

export async function handleBranchPackCollect(
  payload: BranchPackCollectPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
  const p = payload.params;
  let client: Awaited<ReturnType<typeof createExecutorClient>> | null = null;
  const work = await mkdtemp(join(tmpdir(), 'agor-pack-'));
  try {
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    const branch = await resolveExecutorBranch(client, p.branchId);
    const fragmentPath = join(work, 'fragment.zip');
    const writer = new AgorPackWriter();
    const written = pipeline(writer.output, createWriteStream(fragmentPath, { mode: 0o600 }));
    const key = AGOR_PACK_FRAGMENT_KEY;

    const state = await readPackWorkingTreeState(branch.path, { localHome: p.localHome });
    const bundlePath = join(work, 'repo.bundle');
    const bundled = await createPackBundle(branch.path, bundlePath, { localHome: p.localHome });
    if (bundled) {
      await writer.addStream(
        teammatePackPath(key, 'git/repo.bundle'),
        createReadStream(bundlePath),
        {
          compress: false,
        }
      );
    }

    const skipped = [...state.skipped];
    let dirtyFiles = 0;
    for (const file of state.changed) {
      if (!isPortableWorktreePath(file)) {
        skipped.push(file);
        continue;
      }
      const resolved = await resolvePathInsideBranch(branch.path, file, { mustExist: true });
      const info = await lstat(resolved.absolute);
      if (!info.isFile() || info.size > AGOR_PACK.maxEntryBytes) {
        skipped.push(file);
        continue;
      }
      const bytes = await readFile(resolved.absolute);
      const path = teammatePackPath(key, `git/worktree/${file}`);
      if (looksLikeText(bytes)) assertNoSecrets(path, bytes.toString('utf8'));
      writer.addBuffer(path, bytes, { mode: info.mode & 0o111 ? 0o755 : 0o644 });
      dirtyFiles += 1;
    }
    const gitState: AgorPackGitState = {
      version: 1,
      head_sha: state.headSha,
      ref: state.ref,
      deleted: state.deleted.filter(isPortableWorktreePath),
    };
    writer.addJson(teammatePackPath(key, 'git/state.json'), gitState);

    let claudeFiles = 0;
    let claudeBytes = 0;
    if (p.includeClaudeMemory) {
      const claudeRoot = assertBranchHome(p);
      for (const file of await listClaudeHomeFiles(claudeRoot)) {
        const absolute = join(claudeRoot, file);
        const info = await lstat(absolute);
        if (!info.isFile() || info.size > AGOR_PACK.maxTextEntryBytes) continue;
        const bytes = await readFile(absolute);
        const path = teammatePackPath(key, `sdk-home/claude/${file}`);
        if (looksLikeText(bytes)) assertNoSecrets(path, bytes.toString('utf8'));
        writer.addBuffer(path, bytes);
        claudeFiles += 1;
        claudeBytes += bytes.byteLength;
      }
    }

    writer.finishFragment();
    await written;
    const size = (await stat(fragmentPath)).size;
    const response = await fetch(`${daemonUrl}/executor/agor-pack/fragments/${p.exportId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${payload.sessionToken}`,
        'Content-Type': AGOR_PACK.mimeType,
        'Content-Length': String(size),
      },
      body: Readable.toWeb(createReadStream(fragmentPath)) as never,
      duplex: 'half',
    } as RequestInit);
    if (!response.ok) throw new Error(`Pack fragment upload failed with HTTP ${response.status}`);
    const uploaded = (await response.json()) as { ref?: string };
    if (!uploaded.ref) throw new Error('Pack fragment upload returned no reference');
    return {
      success: true,
      data: {
        fragmentRef: uploaded.ref,
        size,
        git: {
          mode: p.localHome ? 'bundle' : 'remote',
          head_sha: state.headSha,
          unpushed_commits: state.unpushedCommits,
          dirty_files: dirtyFiles,
          deleted_files: gitState.deleted.length,
          bundle: bundled,
          skipped_files: skipped.slice(0, 200),
        },
        claudeMemory: p.includeClaudeMemory ? { files: claudeFiles, bytes: claudeBytes } : null,
      },
    };
  } catch (error) {
    return failure('PACK_COLLECT_FAILED', error);
  } finally {
    client?.io.disconnect();
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeEntry(
  reader: AgorPackReader,
  entryPath: string,
  destination: string,
  mode: number
): Promise<void> {
  await rm(destination, { force: true });
  await pipeline(await reader.openStream(entryPath), createWriteStream(destination, { mode }));
  await chmod(destination, mode);
}

export async function handleBranchPackMaterialize(
  payload: BranchPackMaterializePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
  const p = payload.params;
  let client: Awaited<ReturnType<typeof createExecutorClient>> | null = null;
  let reader: AgorPackReader | null = null;
  const work = await mkdtemp(join(tmpdir(), 'agor-pack-'));
  try {
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    const branch = await resolveExecutorBranch(client, p.branchId);
    if (branch.filesystem_status !== 'ready') {
      throw new Error('Branch checkout is not ready yet');
    }
    const packPath = join(work, 'pack.agorpack');
    const response = await fetch(
      `${daemonUrl}/executor/agor-pack/imports/${p.importId}/content?key=${p.teammateKey}`,
      {
        headers: { Authorization: `Bearer ${payload.sessionToken}` },
      }
    );
    if (!response.ok || !response.body) {
      throw new Error(`Pack download failed with HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(packPath, { mode: 0o600 })
    );
    reader = await AgorPackReader.open(await fileByteSource(packPath));
    const prefix = teammatePackPath(p.teammateKey, '');

    let headSha: string | null = null;
    if (reader.has(`${prefix}git/repo.bundle`)) {
      const bundlePath = join(work, 'repo.bundle');
      await pipeline(
        await reader.openStream(`${prefix}git/repo.bundle`),
        createWriteStream(bundlePath, { mode: 0o600 })
      );
      headSha = await applyPackBundle(branch.path, bundlePath);
    }

    if (reader.has(`${prefix}git/state.json`)) {
      const state = await reader.readJson(`${prefix}git/state.json`, agorPackGitStateSchema);
      if (!headSha && state.head_sha && !p.localHome) {
        // Nothing unpushed: the exported HEAD is on the remote the checkout came from.
        if (await resetToPackCommit(branch.path, state.head_sha)) headSha = state.head_sha;
      }
      for (const file of state.deleted) {
        if (!isPortableWorktreePath(file)) continue;
        const resolved = await resolvePathInsideBranch(branch.path, file);
        await rm(resolved.absolute, { force: true });
      }
    }

    let files = 0;
    for (const entry of reader.list(`${prefix}git/worktree/`)) {
      const file = entry.path.slice(`${prefix}git/worktree/`.length);
      if (!isPortableWorktreePath(file)) continue;
      const parent = await resolvePathInsideBranch(branch.path, dirname(file), { allowRoot: true });
      await mkdir(parent.absolute, { recursive: true });
      // Re-resolve after mkdir so a concurrently planted symlink cannot redirect the write.
      const target = await resolvePathInsideBranch(branch.path, file);
      await writeEntry(
        reader,
        entry.path,
        target.absolute,
        reader.mode(entry.path) & 0o111 ? 0o755 : 0o644
      );
      files += 1;
    }

    let claudeFiles = 0;
    const claudeEntries = reader.list(`${prefix}sdk-home/claude/`);
    if (claudeEntries.length > 0) {
      const claudeRoot = assertBranchHome(p);
      await mkdir(claudeRoot, { recursive: true, mode: 0o700 });
      const targetSlug = claudeProjectSlug(branch.path);
      for (const entry of claudeEntries) {
        const source = entry.path.slice(`${prefix}sdk-home/claude/`.length);
        const file = renameClaudeProjectPath(source, p.sourceClaudeProjectSlug, targetSlug);
        if (!isAllowedClaudeHomePath(file)) continue;
        const parent = await resolvePathInsideBranch(claudeRoot, dirname(file), {
          allowRoot: true,
        });
        await mkdir(parent.absolute, { recursive: true, mode: 0o700 });
        const target = await resolvePathInsideBranch(claudeRoot, file);
        await writeEntry(reader, entry.path, target.absolute, 0o600);
        claudeFiles += 1;
      }
    }

    return { success: true, data: { head_sha: headSha, files, claude_files: claudeFiles } };
  } catch (error) {
    return failure('PACK_MATERIALIZE_FAILED', error);
  } finally {
    reader?.close();
    client?.io.disconnect();
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
