import type { AgorConfig, AgorExternalLaunchSettings } from './types';

export const EXTERNAL_LAUNCH_ENV = {
  ENABLED: 'AGOR_EXTERNAL_LAUNCH_ENABLED',
  EXCHANGE_URL: 'AGOR_EXTERNAL_LAUNCH_EXCHANGE_URL',
  ISSUER: 'AGOR_EXTERNAL_LAUNCH_ISSUER',
  AUDIENCE: 'AGOR_EXTERNAL_LAUNCH_AUDIENCE',
  INSTANCE_ID: 'AGOR_EXTERNAL_LAUNCH_INSTANCE_ID',
  FORWARD_REQUEST_HOST: 'AGOR_EXTERNAL_LAUNCH_FORWARD_REQUEST_HOST',
  SERVICE_CREDENTIAL: 'AGOR_EXTERNAL_LAUNCH_SERVICE_TOKEN',
  DEV_SHARED_SECRET: 'AGOR_EXTERNAL_LAUNCH_SHARED_SECRET',
} as const;

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function booleanEnvironmentValue(value: string | undefined, name: string): boolean | undefined {
  const normalized = nonEmptyEnvironmentValue(value)?.toLowerCase();
  if (normalized === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Config error: ${name} must be one of: true, false, 1, 0, yes, no, on, off`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Fold the supported launch-auth environment overrides into the daemon's
 * immutable effective configuration snapshot. Runtime auth code must not
 * re-read process.env after startup.
 */
export function resolveEffectiveExternalLaunchConfig(
  configured: AgorConfig['external_launch'],
  env: NodeJS.ProcessEnv = process.env
): AgorExternalLaunchSettings | undefined {
  if (configured !== undefined && !isObject(configured)) {
    throw new Error('Config error: external_launch must be an object');
  }

  const raw: AgorExternalLaunchSettings = configured ?? {};
  const enabled = booleanEnvironmentValue(
    env[EXTERNAL_LAUNCH_ENV.ENABLED],
    EXTERNAL_LAUNCH_ENV.ENABLED
  );
  const forwardRequestHost = booleanEnvironmentValue(
    env[EXTERNAL_LAUNCH_ENV.FORWARD_REQUEST_HOST],
    EXTERNAL_LAUNCH_ENV.FORWARD_REQUEST_HOST
  );
  const hasLaunchEnvironment = [
    enabled,
    forwardRequestHost,
    nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.EXCHANGE_URL]),
    nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.ISSUER]),
    nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.AUDIENCE]),
    nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.INSTANCE_ID]),
  ].some((value) => value !== undefined);

  if (configured === undefined && !hasLaunchEnvironment) return undefined;

  const serviceCredentialEnv =
    nonEmptyEnvironmentValue(raw.service_credential_env) ?? EXTERNAL_LAUNCH_ENV.SERVICE_CREDENTIAL;
  const sharedSecretEnv =
    nonEmptyEnvironmentValue(raw.dev_shared_secret_env) ?? EXTERNAL_LAUNCH_ENV.DEV_SHARED_SECRET;

  return {
    ...raw,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.EXCHANGE_URL])
      ? { exchange_url: nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.EXCHANGE_URL]) }
      : {}),
    ...(nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.ISSUER])
      ? { issuer: nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.ISSUER]) }
      : {}),
    ...(nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.AUDIENCE])
      ? { audience: nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.AUDIENCE]) }
      : {}),
    ...(nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.INSTANCE_ID])
      ? { instance_id: nonEmptyEnvironmentValue(env[EXTERNAL_LAUNCH_ENV.INSTANCE_ID]) }
      : {}),
    ...(nonEmptyEnvironmentValue(env[serviceCredentialEnv])
      ? { service_credential: nonEmptyEnvironmentValue(env[serviceCredentialEnv]) }
      : {}),
    ...(nonEmptyEnvironmentValue(env[sharedSecretEnv])
      ? { dev_shared_secret: nonEmptyEnvironmentValue(env[sharedSecretEnv]) }
      : {}),
    ...(forwardRequestHost !== undefined ? { forward_request_host: forwardRequestHost } : {}),
  };
}

/**
 * Return the single startup/request-time validation result used by both the
 * config boundary and launch service. Keeping this pure prevents the two
 * enforcement points from accepting different provider configurations.
 */
export function externalLaunchConfigurationError(config: AgorConfig): string | undefined {
  const raw = config.external_launch as unknown;
  if (raw !== undefined && !isObject(raw)) return 'external_launch must be an object';
  if (raw === undefined) return undefined;

  const settings = raw as unknown as AgorExternalLaunchSettings;
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') {
    return 'external_launch.enabled must be a boolean';
  }
  if (settings.enabled !== true) return undefined;
  if (!nonEmptyEnvironmentValue(settings.exchange_url)) {
    return 'external_launch.exchange_url is required when external launch is enabled';
  }
  if (!nonEmptyEnvironmentValue(settings.issuer) || !nonEmptyEnvironmentValue(settings.audience)) {
    return 'external_launch.issuer and external_launch.audience are required when external launch is enabled';
  }

  const configuredKeyCount = [
    settings.jwks_url,
    settings.public_key,
    settings.dev_shared_secret,
  ].filter((value) => nonEmptyEnvironmentValue(value) !== undefined).length;
  if (configuredKeyCount === 0) {
    return 'external_launch requires exactly one assertion verification method';
  }
  if (configuredKeyCount > 1) {
    return 'external_launch must not configure multiple assertion verification methods';
  }

  const usesAsymmetricKey = Boolean(
    nonEmptyEnvironmentValue(settings.jwks_url) || nonEmptyEnvironmentValue(settings.public_key)
  );
  if (usesAsymmetricKey && settings.algorithms?.some((algorithm) => /^hs/i.test(algorithm))) {
    return 'external_launch asymmetric verification cannot use HS* algorithms';
  }
  return undefined;
}

/** Fail startup before database initialization when enabled launch auth is unusable. */
export function assertValidEffectiveExternalLaunchConfig(config: AgorConfig): void {
  const error = externalLaunchConfigurationError(config);
  if (error) throw new Error(`Config error: ${error}`);
}
