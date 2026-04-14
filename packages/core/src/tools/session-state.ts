/**
 * Session State Module
 *
 * Knows how to find, hash, serialize, and restore SDK session files.
 * Used by stateless_fs_mode to persist session transcripts to the database.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';

import type { AgenticToolName } from '@agor/core/types';

/**
 * Encode a filesystem path into a Claude Code project directory name.
 * Replaces every non-alphanumeric character with '-'.
 */
function encodeProjectPath(worktreePath: string): string {
  return worktreePath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Derive the local session file path from tool + worktree path + SDK session ID.
 */
export function getSessionFilePath(
  tool: AgenticToolName,
  worktreePath: string,
  sdkSessionId: string
): string {
  const home = homedir();

  switch (tool) {
    case 'claude-code': {
      const encoded = encodeProjectPath(worktreePath);
      return path.join(home, '.claude', 'projects', encoded, `${sdkSessionId}.jsonl`);
    }
    case 'codex': {
      return path.join(home, '.codex', 'sessions', `${sdkSessionId}.json`);
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
