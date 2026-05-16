/**
 * Executor Configuration Module
 *
 * Strict, executor-local config helpers. The executor MUST NOT read
 * `~/.agor/config.yaml` directly — see context/explorations/daemon-fs-decoupling.md
 * §1.5 (H1) for the contract. Anything the executor needs is either:
 *
 *   - an environment variable set by the daemon at spawn time (DAEMON_URL,
 *     credential env vars routed via the 0600 env-file), or
 *   - a field on the payload's `resolvedConfig` slice.
 */

/**
 * Daemon URL for this executor. Sourced from `process.env.DAEMON_URL`, which
 * is set by `apps/agor-daemon/src/utils/spawn-executor.ts` (stdin mode) or
 * by `packages/executor/src/cli.ts` (legacy CLI mode) before any SDK handler
 * runs. Throws when missing — there is no fallback to config.yaml.
 *
 * Returned as a Promise to preserve the existing `await getDaemonUrl()`
 * call shape at the SDK handler sites; the function is effectively
 * synchronous and never blocks.
 */
export async function getDaemonUrl(): Promise<string> {
  const url = process.env.DAEMON_URL;
  if (!url) {
    throw new Error(
      'Executor expected DAEMON_URL to be set on its environment. ' +
        'In stdin mode this is set by the daemon when spawning the executor; ' +
        'in legacy CLI mode it is seeded from --daemon-url. Reaching this ' +
        'error means neither happened — investigate the executor entry point.'
    );
  }
  return url;
}

/**
 * Resolve user environment (cwd, env vars, etc.)
 * In executor mode, environment is inherited from the executor process
 */
export function resolveUserEnvironment() {
  return {
    cwd: process.cwd(),
    env: process.env,
  };
}
