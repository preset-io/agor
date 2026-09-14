import { buildAllowlistedEnv, TRUSTED_LAUNCHER_ENV_PREFIX } from '@agor/core/config';

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
