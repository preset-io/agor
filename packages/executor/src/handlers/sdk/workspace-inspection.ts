import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  WORKLOAD_LOCKFILES,
  type WorkloadFileObservation,
  type WorkloadPackageManagerObservation,
  type WorkloadToolVersionObservation,
  type WorkloadWorkspaceInspection,
} from '@agor/core/types';

export const WORKLOAD_PACKAGE_JSON_MAX_BYTES = 64 * 1024;
export const WORKLOAD_LOCKFILE_MAX_BYTES = 16 * 1024 * 1024;
export const WORKLOAD_TOOL_VERSION_MAX_BYTES = 64;
export const WORKLOAD_TOOL_VERSION_TIMEOUT_MS = 3_000;

type SafeFileRead = {
  observation: WorkloadFileObservation;
  content?: Buffer;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function fileStateFromStats(stats: Stats): WorkloadFileObservation | undefined {
  if (stats.isSymbolicLink()) return { state: 'unsafe-symlink' };
  if (!stats.isFile()) return { state: 'not-regular' };
  return undefined;
}

/**
 * Read one fixed root file through an inode opened with O_NOFOLLOW. The caller
 * supplies only names from source-owned allowlists; no request value reaches
 * this boundary.
 */
async function readFixedRootFile(
  workspaceCwd: string,
  filename: string,
  maxBytes: number,
  signal: AbortSignal,
  retainContent = false
): Promise<SafeFileRead | undefined> {
  if (signal.aborted) return undefined;
  const target = join(workspaceCwd, filename);
  let pathStats: Stats;
  try {
    pathStats = await lstat(target);
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { observation: { state: 'absent' } }
      : { observation: { state: 'unreadable' } };
  }
  if (signal.aborted) return undefined;
  const unsafeState = fileStateFromStats(pathStats);
  if (unsafeState) return { observation: unsafeState };
  if (pathStats.size > maxBytes) return { observation: { state: 'too-large' } };
  if (typeof constants.O_NOFOLLOW !== 'number') {
    return { observation: { state: 'unreadable' } };
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) return { observation: { state: 'not-regular' } };
    if (openedStats.dev !== pathStats.dev || openedStats.ino !== pathStats.ino) {
      return { observation: { state: 'unreadable' } };
    }
    if (openedStats.size > maxBytes) return { observation: { state: 'too-large' } };

    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, openedStats.size)));
    let offset = 0;
    while (offset < openedStats.size) {
      if (signal.aborted) return undefined;
      const length = Math.min(buffer.byteLength, openedStats.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) return { observation: { state: 'unreadable' } };
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(chunk);
      if (retainContent) chunks.push(chunk);
      offset += bytesRead;
    }
    if (signal.aborted) return undefined;
    return {
      observation: { state: 'present', sha256: hash.digest('hex') },
      ...(retainContent ? { content: Buffer.concat(chunks) } : {}),
    };
  } catch (error) {
    const code = errorCode(error);
    return {
      observation:
        code === 'ELOOP' || code === 'EMLINK'
          ? { state: 'unsafe-symlink' }
          : code === 'ENOENT'
            ? { state: 'absent' }
            : { state: 'unreadable' },
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parsePackageManager(file: SafeFileRead): WorkloadPackageManagerObservation {
  if (file.observation.state === 'absent') return { state: 'absent' };
  const { content } = file;
  if (!content) return { state: 'unavailable' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    return { state: 'invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'invalid' };
  }
  const declaration = (parsed as Record<string, unknown>).packageManager;
  if (declaration === undefined) return { state: 'absent' };
  if (typeof declaration !== 'string') return { state: 'invalid' };
  const match = /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(declaration);
  if (!match) return { state: 'invalid' };
  return {
    state: 'valid',
    name: match[1] as 'npm' | 'pnpm' | 'yarn' | 'bun',
    version: match[2]!,
  };
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {
    // Fall through to the direct child handle when its process group already exited.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The close/error event remains the settlement source.
  }
}

async function fixedToolVersion(
  executable: 'npm' | 'pnpm',
  workspaceCwd: string,
  signal: AbortSignal
): Promise<WorkloadToolVersionObservation | undefined> {
  if (signal.aborted) return undefined;
  return new Promise((resolve) => {
    let output = Buffer.alloc(0);
    let timedOut = false;
    let overflowed = false;
    let spawnFailure: WorkloadToolVersionObservation | undefined;
    let settled = false;
    const pathValue = process.env.PATH ?? process.env.Path;
    const child = spawn(executable, ['--version'], {
      cwd: workspaceCwd,
      env: {
        ...(pathValue ? { PATH: pathValue } : {}),
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        NO_UPDATE_NOTIFIER: '1',
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      },
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (observation: WorkloadToolVersionObservation | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve(observation);
    };
    const stopForInvalidOutput = () => {
      overflowed = true;
      terminateChild(child);
    };
    const append = (chunk: Buffer) => {
      if (overflowed) return;
      if (output.byteLength + chunk.byteLength > WORKLOAD_TOOL_VERSION_MAX_BYTES) {
        stopForInvalidOutput();
        return;
      }
      output = Buffer.concat([output, chunk]);
    };
    const onAbort = () => terminateChild(child);
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, WORKLOAD_TOOL_VERSION_TIMEOUT_MS);
    timeout.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => {
      spawnFailure = {
        state: errorCode(error) === 'ENOENT' ? 'unavailable' : 'failed',
      };
    });
    child.once('close', (code) => {
      if (signal.aborted) return finish(undefined);
      if (timedOut) return finish({ state: 'timed-out' });
      if (overflowed) return finish({ state: 'invalid-output' });
      if (spawnFailure) return finish(spawnFailure);
      if (code !== 0) return finish({ state: 'failed' });
      const version = output.toString('utf8').trim();
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        return finish({ state: 'invalid-output' });
      }
      return finish({ state: 'available', version });
    });
  });
}

async function repositoryMarkerPresent(workspaceCwd: string): Promise<boolean> {
  try {
    const stats = await lstat(join(workspaceCwd, '.git'));
    return !stats.isSymbolicLink() && (stats.isFile() || stats.isDirectory());
  } catch {
    return false;
  }
}

/** Inspect only fixed root facts in the daemon-authoritative workspace cwd. */
export async function inspectWorkspace(
  workspaceCwd: string,
  signal: AbortSignal
): Promise<WorkloadWorkspaceInspection | undefined> {
  if (!isAbsolute(workspaceCwd)) throw new Error('WORKLOAD_WORKSPACE_UNAVAILABLE');
  const packageJson = await readFixedRootFile(
    workspaceCwd,
    'package.json',
    WORKLOAD_PACKAGE_JSON_MAX_BYTES,
    signal,
    true
  );
  if (!packageJson || signal.aborted) return undefined;

  const lockfiles: WorkloadWorkspaceInspection['lockfiles'] = [];
  for (const name of WORKLOAD_LOCKFILES) {
    const file = await readFixedRootFile(workspaceCwd, name, WORKLOAD_LOCKFILE_MAX_BYTES, signal);
    if (!file || signal.aborted) return undefined;
    lockfiles.push({ name, file: file.observation });
  }

  const [npm, pnpm] = await Promise.all([
    fixedToolVersion('npm', workspaceCwd, signal),
    fixedToolVersion('pnpm', workspaceCwd, signal),
  ]);
  if (!npm || !pnpm || signal.aborted) return undefined;

  const nodeVersion = process.versions.node;
  const markerPresent = await repositoryMarkerPresent(workspaceCwd);
  if (signal.aborted) return undefined;
  return {
    node: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(nodeVersion)
      ? { state: 'available', version: nodeVersion }
      : { state: 'invalid-output' },
    npm,
    pnpm,
    packageJson: packageJson.observation,
    packageManager: parsePackageManager(packageJson),
    lockfiles,
    repositoryMarkerPresent: markerPresent,
  };
}
