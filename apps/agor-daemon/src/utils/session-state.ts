/**
 * Session State Module
 *
 * Knows how to find, hash, serialize, and restore SDK session files.
 * Used by stateless_fs_mode to persist session transcripts to the database.
 *
 * Lives in the daemon (not core) because it orchestrates DB + filesystem
 * operations that are daemon-specific.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';

import { getTranscriptPath } from '@agor/core/claude';
import type { AgenticToolName } from '@agor/core/types';

/**
 * Resolve the Codex home directory (where `auth.json`, `sessions/`, and
 * any user-authored `config.toml` live).
 *
 * Defaults to `$HOME/.codex`. In strict / insulated unix-user modes the
 * caller passes the impersonated user's home dir; in simple mode it is
 * undefined and we fall back to the daemon process's `os.homedir()`.
 *
 * NOTE: this used to return a per-session `/tmp/agor-codex-<sessionId>`
 * directory back when Agor overrode `$CODEX_HOME`. The executor no longer
 * does that — Codex CLI is invoked with its default `$CODEX_HOME` so its
 * subscription auth + user config keep working.
 */
export function getCodexHome(executorHomeDir?: string): string {
  return path.join(executorHomeDir || os.homedir(), '.codex');
}

export function getSessionFilePath(
  tool: AgenticToolName,
  worktreePath: string,
  sdkSessionId: string,
  homeOverride?: string
): string {
  switch (tool) {
    case 'claude-code': {
      // getTranscriptPath uses process.env.HOME internally.
      // When we need a different user's home, construct the path directly
      // using the same encoding logic.
      if (homeOverride) {
        const projectSlug = worktreePath.replace(/[^a-zA-Z0-9]/g, '-');
        return path.join(homeOverride, '.claude', 'projects', projectSlug, `${sdkSessionId}.jsonl`);
      }
      return getTranscriptPath(sdkSessionId, worktreePath);
    }
    case 'codex': {
      // homeOverride here is the executor user's HOME dir (not CODEX_HOME).
      // Codex stores threads at $CODEX_HOME/sessions, default $CODEX_HOME=$HOME/.codex.
      // The Codex CLI searches for threads by ID, so a flat path works for restore.
      const codexHome = getCodexHome(homeOverride);
      return path.join(codexHome, 'sessions', `${sdkSessionId}.jsonl`);
    }
    default:
      throw new Error(`getSessionFilePath: unsupported tool '${tool}'`);
  }
}

/**
 * Find the actual session file on disk for Codex.
 * Codex stores sessions in date-based directories:
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl
 *
 * For push (after execution), the file may be at a dated path OR the canonical
 * flat path (if restored by pull). This function searches both.
 *
 * Returns the absolute path if found, or null.
 */
export async function findCodexSessionFile(
  codexHome: string,
  threadId: string
): Promise<string | null> {
  const sessionsDir = path.join(codexHome, 'sessions');

  // First check the canonical flat path (used by pull/restore)
  const canonicalPath = path.join(sessionsDir, `${threadId}.jsonl`);
  try {
    await stat(canonicalPath);
    return canonicalPath;
  } catch {
    // Not at canonical path, search in date directories
  }

  // Recursively search for *-{threadId}.jsonl in the sessions directory tree
  try {
    return await findFileRecursive(sessionsDir, threadId);
  } catch {
    return null;
  }
}

/**
 * Recursively search a directory for a file containing the threadId in its name.
 */
async function findFileRecursive(dir: string, threadId: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(fullPath, threadId);
      if (found) return found;
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Compute MD5 hash of file contents.
 * Returns empty string '' if file doesn't exist.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  try {
    await stat(filePath);
  } catch {
    return '';
  }

  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Gzip a single file and return the compressed Buffer.
 */
export async function serializeFile(filePath: string): Promise<Buffer> {
  const data = await readFile(filePath);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gzip = createGzip();
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
    gzip.end(data);
  });
}

/**
 * Decompress a gzipped Buffer and write to filePath.
 * Creates parent directories if needed.
 */
export async function restoreFile(filePath: string, payload: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const out = createWriteStream(filePath);
    gunzip.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    gunzip.on('error', reject);
    gunzip.end(payload);
  });
}
