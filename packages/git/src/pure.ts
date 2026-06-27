/**
 * Pure git helpers: string/path/env utilities that do not spawn git and do not
 * touch repo/worktree filesystem contents. Safe for daemon imports.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const DEFAULT_AUTH_HEADER_HOST = 'github.com';

function expandHomePath(input: string): string {
  if (!input) return input;
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function getAgorHome(): string {
  return path.join(os.homedir(), '.agor');
}

function getDataHome(): string {
  if (process.env.AGOR_DATA_HOME) return expandHomePath(process.env.AGOR_DATA_HOME);
  try {
    const raw = readFileSync(path.join(getAgorHome(), 'config.yaml'), 'utf-8');
    const config = (yaml.load(raw) ?? {}) as { paths?: { data_home?: string } };
    if (config.paths?.data_home) return expandHomePath(config.paths.data_home);
  } catch {
    // Fall through to AGOR_HOME when config is absent or unreadable. This mirrors
    // the git helper's historical best-effort path behavior without depending on
    // @agor/core's full config loader.
  }
  return getAgorHome();
}

export function getReposDir(): string {
  return path.join(getDataHome(), 'repos');
}

export function getBranchesDir(): string {
  return path.join(getDataHome(), 'worktrees');
}

export function getBranchPath(repoSlug: string, branchName: string): string {
  return path.join(getBranchesDir(), repoSlug, branchName);
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function redactUrlUserinfo(input: string): string {
  return input.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s]*@)([^/?#\s]+)/g,
    (_match, prefix: string, _userinfo: string, host: string) => `${prefix}<redacted>@${host}`
  );
}

function httpUrlHasUserinfo(rawUrl: string): boolean {
  if (!/^https?:\/\//i.test(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return /^https?:\/\/[^/?#\s]*@[^/?#\s]+/i.test(rawUrl);
  }
}

function stripHttpUrlUserinfo(rawUrl: string): string {
  if (!/^https?:\/\//i.test(rawUrl)) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return rawUrl;
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl.replace(/^(https?:\/\/)([^/?#\s]*@)([^/?#\s]+)/i, '$1$3');
  }
}

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

/**
 * Extract the hostname from a git remote URL.
 */
export function parseHostFromGitUrl(url: string): string | undefined {
  if (typeof url !== 'string' || url.length === 0) return undefined;

  if (/^(?:https?|ssh):\/\//.test(url)) {
    try {
      return new URL(url).hostname || undefined;
    } catch {
      return undefined;
    }
  }

  return url.match(/^(?:[^@\s:]+@)?([^/:\s]+):(?!\/)/)?.[1];
}

/** True when an HTTP(S) git URL embeds URL userinfo. */
export function gitUrlHasUserinfo(rawUrl: string): boolean {
  return httpUrlHasUserinfo(rawUrl);
}

/** Redact URL userinfo for logs/errors. */
export function redactGitUrlCredentials(rawUrl: string): string {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rawUrl)) return rawUrl;
  return redactUrlUserinfo(rawUrl);
}

/** Remove HTTP(S) URL userinfo from a git URL. */
export function stripGitUrlCredentials(rawUrl: string): string {
  return stripHttpUrlUserinfo(rawUrl);
}
