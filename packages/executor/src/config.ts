/**
 * Executor Configuration Module
 *
 * Re-exports configuration utilities used by SDK handlers
 */

// Re-export getDaemonUrl from feathers-client
export { getDaemonUrl } from './services/feathers-client.js';

/**
 * Resolve API key for SDK execution
 * In executor mode, API keys are passed directly from daemon via IPC
 */
export function resolveApiKey(apiKey: string): string {
  return apiKey;
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
