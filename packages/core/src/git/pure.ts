/**
 * Pure git helpers: string/path/env utilities that do not spawn git and do not
 * touch repo/worktree filesystem contents. Safe for daemon imports.
 */

import { Buffer } from 'node:buffer';
import { getBranchesDir, getBranchPath, getReposDir } from '../config/config-manager';
import { escapeShellArg } from '../unix/run-as-user';

const DEFAULT_AUTH_HEADER_HOST = 'github.com';

export { getBranchesDir, getBranchPath, getReposDir };

/**
 * Loose shape check for GitHub / GitLab personal access tokens we will put
 * into a git-credentials file.
 */
export function isLikelyGitToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,255}$/.test(token);
}

/**
 * Encode git config entries as GIT_CONFIG_COUNT / KEY_N / VALUE_N env vars.
 */
export function buildGitConfigEnv(entries: [string, string][]): Record<string, string> {
  if (entries.length === 0) return {};
  const out: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
  };
  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  return out;
}

/**
 * Encode pairs into the GIT_CONFIG_PARAMETERS single-quote protocol.
 */
export function buildGitConfigParameters(pairs: readonly string[]): string {
  return pairs
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair) => escapeShellArg(pair))
    .join(' ');
}

/**
 * Build scoped HTTPS Authorization extraheader entries for git.
 */
export function buildAuthHeaderEnv(
  token: string | undefined,
  host: string = DEFAULT_AUTH_HEADER_HOST
): [string, string][] {
  if (!token) return [];
  if (!isLikelyGitToken(token)) {
    console.warn(
      '🔑 Skipping http.extraheader: token does not match expected shape. ' +
        'Tokens must match /^[A-Za-z0-9_-]{20,255}$/. ' +
        'Re-save the token to enable the auth header.'
    );
    return [];
  }
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return [[`http.https://${host}/.extraheader`, `Authorization: Basic ${encoded}`]];
}

/**
 * Extract repo name from Git URL.
 */
export function extractRepoName(url: string): string {
  const match = url.match(/\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Could not extract repo name from URL: ${url}`);
  }
  return match[1];
}
