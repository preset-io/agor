/**
 * Spawn configuration for the Oh My Pi runtime.
 *
 * ## Profile and authentication
 *
 * By default Agor runs OMP under the host user's **default** profile
 * (`~/.omp/agent`). That is deliberate: OMP owns its own credentials, and a
 * named profile starts with an empty auth store, so an isolated profile would
 * leave the agent unable to reach any model until the user separately signed
 * that profile in. Using the default profile means "install OMP, run it once,
 * sign in" is the whole setup story.
 *
 * Operators who *want* isolation can set `AGOR_OMP_PROFILE` and sign that
 * profile in with `omp --profile <name>`.
 *
 * ## MCP injection
 *
 * OMP has no `--mcp-config` flag; it discovers MCP servers from files. Writing
 * one into the branch worktree would leave a stray untracked file in the
 * user's git status, so Agor writes to the profile's user-level `mcp.json`,
 * which lives outside any repo.
 *
 * That file is shared by every session, so the Agor endpoint is templated with
 * `${...}` placeholders that OMP expands per process from the environment.
 * One static file therefore stays correct for concurrent sessions instead of
 * racing to rewrite per-session values — and outside Agor the placeholders
 * resolve to nothing, so the entry is inert in a normal terminal session.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Env var an operator sets to run OMP under an isolated named profile. */
export const AGOR_OMP_PROFILE_ENV = 'AGOR_OMP_PROFILE';

/** Name of the injected MCP server inside OMP. */
export const AGOR_OMP_MCP_SERVER_NAME = 'agor';

/** Env var carrying the per-session Agor MCP endpoint. */
export const AGOR_MCP_URL_ENV = 'AGOR_MCP_URL';

/** Env var carrying the per-session Agor MCP bearer token. */
export const AGOR_MCP_TOKEN_ENV = 'AGOR_MCP_TOKEN';

const MCP_SCHEMA_URL =
  'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json';

/**
 * Root of an OMP profile's agent directory.
 *
 * The default profile (no name) lives at `~/.omp/agent`; a named profile at
 * `~/.omp/profiles/<name>/agent`.
 */
export function getOmpAgentDir(profile?: string, home: string = homedir()): string {
  return profile ? join(home, '.omp', 'profiles', profile, 'agent') : join(home, '.omp', 'agent');
}

/** Path to the user-level `mcp.json` for a profile. */
export function getOmpMcpConfigPath(profile?: string, home: string = homedir()): string {
  return join(getOmpAgentDir(profile, home), 'mcp.json');
}

/** Shape Agor writes into OMP's `mcp.json`. */
interface OmpMcpConfigFile {
  $schema?: string;
  mcpServers?: Record<string, unknown>;
  disabledServers?: string[];
  [key: string]: unknown;
}

/**
 * The Agor MCP server entry, templated so one file serves every session.
 *
 * OMP expands `${VAR}` while discovering MCP configs, resolving both fields
 * from the spawned process's environment.
 */
function agorMcpServerEntry(): Record<string, unknown> {
  return {
    type: 'http',
    url: `\${${AGOR_MCP_URL_ENV}}`,
    headers: { Authorization: `Bearer \${${AGOR_MCP_TOKEN_ENV}}` },
  };
}

/**
 * Ensure the Agor MCP server is registered in the profile's `mcp.json`.
 *
 * Merges into any existing file rather than overwriting, so the user's own MCP
 * servers survive. Idempotent: rewrites only when the Agor entry is missing or
 * stale.
 */
export async function ensureAgorMcpConfig(options?: {
  profile?: string;
  home?: string;
}): Promise<string> {
  const home = options?.home ?? homedir();
  const agentDir = getOmpAgentDir(options?.profile, home);
  const configPath = getOmpMcpConfigPath(options?.profile, home);

  let config: OmpMcpConfigFile = {};
  try {
    const existing = await readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed === 'object' && parsed !== null) {
      config = { ...parsed };
    }
  } catch {
    // Missing or unparseable file — start from a fresh config.
  }

  const desired = agorMcpServerEntry();
  const servers =
    typeof config.mcpServers === 'object' && config.mcpServers !== null
      ? { ...config.mcpServers }
      : {};
  if (JSON.stringify(servers[AGOR_OMP_MCP_SERVER_NAME]) === JSON.stringify(desired)) {
    return configPath;
  }
  servers[AGOR_OMP_MCP_SERVER_NAME] = desired;

  await mkdir(agentDir, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ $schema: MCP_SCHEMA_URL, ...config, mcpServers: servers }, null, 2)}\n`,
    'utf8'
  );
  return configPath;
}

export interface OmpEnvOptions {
  /** Base environment to extend, normally `process.env`. */
  base: NodeJS.ProcessEnv;
  /** Agor daemon URL, e.g. `http://127.0.0.1:5150`. */
  daemonUrl?: string;
  /** Per-session MCP bearer token issued by the daemon. */
  mcpToken?: string;
  /** Named profile, when the operator opted into isolation. */
  profile?: string;
}

/**
 * Build the child environment for an OMP session.
 *
 * When no MCP token was issued the Agor endpoint vars are left unset: OMP then
 * fails to resolve that one server and skips it, which is the correct
 * degradation — the session still runs, just without Agor self-drive tools.
 */
export function buildOmpEnv(options: OmpEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...options.base };
  // Only pin a profile when one was explicitly requested; otherwise inherit
  // the user's default OMP profile (and therefore their existing login).
  if (options.profile) {
    env.OMP_PROFILE = options.profile;
  } else {
    delete env.OMP_PROFILE;
  }
  if (options.daemonUrl && options.mcpToken) {
    env[AGOR_MCP_URL_ENV] = `${options.daemonUrl.replace(/\/+$/, '')}/mcp`;
    env[AGOR_MCP_TOKEN_ENV] = options.mcpToken;
  } else {
    delete env[AGOR_MCP_URL_ENV];
    delete env[AGOR_MCP_TOKEN_ENV];
  }
  return env;
}
