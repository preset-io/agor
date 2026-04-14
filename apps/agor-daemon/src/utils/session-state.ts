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
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';

import { getTranscriptPath } from '@agor/core/claude';
import type { AgenticToolName } from '@agor/core/types';

/**
 * Derive the local session file path from tool + worktree path + SDK session ID.
 * Delegates to getTranscriptPath for Claude Code to stay DRY with existing path encoding.
 *
 * @param homeOverride - Override for the home directory. When the executor runs as
 *   a different Unix user (insulated/strict mode), pass that user's home directory
 *   so the path resolves correctly. Defaults to the daemon's own homedir().
 */
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
        const projectSlug = worktreePath.replace(/\//g, '-').replace(/\\/g, '-');
        return path.join(homeOverride, '.claude', 'projects', projectSlug, `${sdkSessionId}.jsonl`);
      }
      return getTranscriptPath(sdkSessionId, worktreePath);
    }
    default:
      throw new Error(`getSessionFilePath: unsupported tool '${tool}'`);
  }
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
