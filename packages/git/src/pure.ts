/**
 * Pure git helpers: string/path/env utilities that do not spawn git and do not
 * touch repo/worktree filesystem contents. Safe for daemon imports.
 */

import { Buffer } from 'node:buffer';

const DEFAULT_AUTH_HEADER_HOST = 'github.com';

/**
 * Explicit user-managed values that Agor's fixed Git operations understand.
 * This is intentionally a capability DTO, not a generic user environment bag.
 */
export const USER_GIT_ENVIRONMENT_NAMES = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

export type UserGitEnvironmentName = (typeof USER_GIT_ENVIRONMENT_NAMES)[number];
export type UserGitEnvironment = Partial<Record<UserGitEnvironmentName, string>>;

export interface HttpGitRemoteScope {
  protocol: 'http:' | 'https:';
  /** URL authority used by Git's http.<url> subsection, including a nondefault port. */
  authority: string;
}

const USER_GIT_ENVIRONMENT_NAME_SET = new Set<string>(USER_GIT_ENVIRONMENT_NAMES);
const MAX_USER_GIT_ENV_VALUE_BYTES = 10 * 1024;

/**
 * Project a generic resolved user map into the bounded Git capability DTO.
 * Unknown values (for example STRIPE_API_KEY) never reach a Git child merely
 * because they were globally configured for an agent session.
 */
export function filterUserGitEnvironment(env: Record<string, string> | undefined): {
  env: UserGitEnvironment;
  rejected: string[];
} {
  const safe: UserGitEnvironment = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (
      !USER_GIT_ENVIRONMENT_NAME_SET.has(key) ||
      value.includes('\0') ||
      Buffer.byteLength(value, 'utf8') > MAX_USER_GIT_ENV_VALUE_BYTES
    ) {
      rejected.push(key);
      continue;
    }
    safe[key as UserGitEnvironmentName] = value;
  }
  return { env: safe, rejected };
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

/** Resolve the exact HTTP config authority, preserving nondefault ports. */
export function parseHttpGitRemoteScope(url: string): HttpGitRemoteScope | undefined {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return { protocol: parsed.protocol, authority: parsed.host };
  } catch {
    return undefined;
  }
}

/**
 * Reject option-shaped and remote-helper inputs before any Git argument is
 * assembled. Managed production remotes use HTTP(S), SSH, or SCP syntax;
 * absolute/file paths remain available for explicit local/test workflows.
 */
export function assertSafeGitRemoteUrl(rawUrl: string): string {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.startsWith('-') ||
    /[\0\r\n]/.test(rawUrl) ||
    rawUrl.trim() !== rawUrl
  ) {
    throw new Error('Invalid Git remote URL');
  }

  if (/^https?:\/\//i.test(rawUrl) || /^ssh:\/\//i.test(rawUrl) || /^git:\/\//i.test(rawUrl)) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Invalid Git remote URL');
    }
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('Unsupported Git remote protocol');
    }
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.username || parsed.password)
    ) {
      throw new Error('Git remote URL must not contain credentials');
    }
    if (parsed.protocol === 'ssh:') {
      if (parsed.password) throw new Error('SSH Git remote URL must not contain a password');
      if (parsed.username && !/^[A-Za-z0-9._-]{1,64}$/.test(parsed.username)) {
        throw new Error('SSH Git remote URL contains an invalid username');
      }
    }
    if (!parsed.pathname || parsed.pathname === '/') {
      throw new Error('Git remote URL must include a repository path');
    }
    return rawUrl;
  }

  if (/^file:\/\//i.test(rawUrl)) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Invalid file Git remote URL');
    }
    if (parsed.protocol !== 'file:' || !parsed.pathname.startsWith('/')) {
      throw new Error('Invalid file Git remote URL');
    }
    return rawUrl;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rawUrl)) {
    throw new Error('Unsupported Git remote protocol');
  }

  if (/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^\s]+$/.test(rawUrl)) return rawUrl;
  if (rawUrl.startsWith('/')) return rawUrl;

  // In particular, reject `<helper>::...`, unknown schemes, relative paths,
  // and other inputs that make Git select an executable remote helper.
  throw new Error('Unsupported Git remote URL');
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
