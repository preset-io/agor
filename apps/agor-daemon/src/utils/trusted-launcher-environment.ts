import { buildAllowlistedEnv } from '@agor/core/config';

/**
 * Reserved ambient namespace for operator-configured Cloud launcher helpers.
 *
 * These values are intentionally available only to trusted external launcher
 * processes. They are not part of the user/session environment and must never
 * be copied into an executor payload.
 */
const TRUSTED_LAUNCHER_ENV_PREFIX = 'AGOR_CLOUD_';

/**
 * Build the environment for a trusted operator-configured launcher/helper.
 *
 * The base allowlist carries inert process runtime metadata. The reserved
 * `AGOR_CLOUD_*` namespace is the sole ambient credential exception; database,
 * master/JWT, provider, and other daemon-internal secrets remain withheld.
 * Undefined values are omitted rather than materialized in the child env. A
 * caller may supply only the already-resolved launcher log level as an
 * explicit override.
 */
export function buildTrustedLauncherEnvironment(logLevel?: string): Record<string, string> {
  const environment = buildAllowlistedEnv();

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name.startsWith(TRUSTED_LAUNCHER_ENV_PREFIX)) {
      environment[name] = value;
    }
  }

  if (logLevel !== undefined) environment.LOG_LEVEL = logLevel;

  return environment;
}
