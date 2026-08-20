import { createPublicKey, type KeyObject } from 'node:crypto';
import {
  type AgorConfig,
  AgorExternalLaunchAlgorithm,
  type AgorExternalLaunchSettings,
  type ResolvedExternalLaunchSettings,
} from './types';

export const EXTERNAL_LAUNCH_DEFAULT_TIMEOUT_MS = 10_000;
export const EXTERNAL_LAUNCH_MAX_TIMEOUT_MS = 120_000;
export const EXTERNAL_LAUNCH_DEFAULT_TRUSTED_HOST_HEADER = 'host';
export const EXTERNAL_LAUNCH_DEFAULT_RETURN_HOST_PARAM = 'return_host';

const RESERVED_RETURN_TO_PARAM = 'return_to';
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function requiredString(
  raw: Record<string, unknown>,
  key: keyof AgorExternalLaunchSettings,
  options: { preserveWhitespace?: boolean } = {}
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`external_launch.${key} must be a non-empty string`);
  }
  return options.preserveWhitespace ? value : value.trim();
}

function optionalBoolean(
  raw: Record<string, unknown>,
  key: keyof AgorExternalLaunchSettings,
  fallback = false
): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`external_launch.${key} must be a boolean`);
  }
  return value;
}

function httpUrl(
  value: string | undefined,
  path: string,
  options: { rejectUserinfo?: boolean } = {}
): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${path} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${path} must be a valid HTTP(S) URL`);
  }
  if (options.rejectUserinfo && (parsed.username || parsed.password)) {
    throw new Error(`${path} must not include URL credentials`);
  }
  return value;
}

function parseAlgorithms(
  raw: Record<string, unknown>
): ResolvedExternalLaunchSettings['algorithms'] {
  const algorithms = raw.algorithms;
  if (algorithms === undefined) return undefined;
  if (!Array.isArray(algorithms) || algorithms.length === 0) {
    throw new Error('external_launch.algorithms must be a non-empty array');
  }
  const supported = new Set<string>(Object.values(AgorExternalLaunchAlgorithm));
  if (algorithms.some((algorithm) => typeof algorithm !== 'string' || !supported.has(algorithm))) {
    throw new Error(`external_launch.algorithms may only contain: ${[...supported].join(', ')}`);
  }
  return algorithms as ResolvedExternalLaunchSettings['algorithms'];
}

const DEFAULT_HMAC_ALGORITHMS = [AgorExternalLaunchAlgorithm.HS256];
const DEFAULT_RSA_ALGORITHMS = [AgorExternalLaunchAlgorithm.RS256];

const EC_CURVE_ALGORITHM = new Map<string, AgorExternalLaunchAlgorithm>([
  ['prime256v1', AgorExternalLaunchAlgorithm.ES256],
  ['secp256r1', AgorExternalLaunchAlgorithm.ES256],
  ['P-256', AgorExternalLaunchAlgorithm.ES256],
  ['secp384r1', AgorExternalLaunchAlgorithm.ES384],
  ['P-384', AgorExternalLaunchAlgorithm.ES384],
  ['secp521r1', AgorExternalLaunchAlgorithm.ES512],
  ['P-521', AgorExternalLaunchAlgorithm.ES512],
]);

function publicKeyAlgorithms(
  key: KeyObject,
  configured: ResolvedExternalLaunchSettings['algorithms']
): ResolvedExternalLaunchSettings['algorithms'] {
  if (key.asymmetricKeyType === 'rsa') {
    const algorithms = configured ?? DEFAULT_RSA_ALGORITHMS;
    if (
      algorithms.some((algorithm) => !algorithm.startsWith('RS') && !algorithm.startsWith('PS'))
    ) {
      throw new Error('external_launch RSA public keys may only use RS* or PS* algorithms');
    }
    return algorithms;
  }

  if (key.asymmetricKeyType === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    const expected = curve ? EC_CURVE_ALGORITHM.get(curve) : undefined;
    if (!expected) {
      throw new Error('external_launch.public_key uses an unsupported elliptic curve');
    }
    const algorithms = configured ?? [expected];
    if (algorithms.some((algorithm) => algorithm !== expected)) {
      throw new Error(
        `external_launch EC public key curve ${curve} requires the ${expected} algorithm`
      );
    }
    return algorithms;
  }

  throw new Error(
    `external_launch.public_key uses unsupported key type ${key.asymmetricKeyType ?? 'unknown'}`
  );
}

function parseExternalLaunchSettings(
  config: AgorConfig,
  options: { requireCompleteProvider?: boolean } = {}
): ResolvedExternalLaunchSettings {
  const rawValue = config.external_launch as unknown;
  if (rawValue !== undefined && !isObject(rawValue)) {
    throw new Error('external_launch must be an object');
  }
  const raw = rawValue ?? {};

  const enabled = optionalBoolean(raw, 'enabled');
  const exchangeUrl = httpUrl(requiredString(raw, 'exchange_url'), 'external_launch.exchange_url', {
    rejectUserinfo: true,
  });
  const issuer = requiredString(raw, 'issuer');
  const audience = requiredString(raw, 'audience');
  const instanceId = requiredString(raw, 'instance_id');
  const providerId = requiredString(raw, 'provider_id');
  const jwksUrl = httpUrl(requiredString(raw, 'jwks_url'), 'external_launch.jwks_url', {
    rejectUserinfo: true,
  });
  const publicKey = requiredString(raw, 'public_key', { preserveWhitespace: true });
  const devSharedSecret = requiredString(raw, 'dev_shared_secret', { preserveWhitespace: true });
  const serviceCredential = requiredString(raw, 'service_credential', {
    preserveWhitespace: true,
  });
  const devSharedSecretEnv = requiredString(raw, 'dev_shared_secret_env');
  const serviceCredentialEnv = requiredString(raw, 'service_credential_env');
  for (const [path, value] of [
    ['external_launch.dev_shared_secret_env', devSharedSecretEnv],
    ['external_launch.service_credential_env', serviceCredentialEnv],
  ] as const) {
    if (value !== undefined && !ENVIRONMENT_VARIABLE_NAME.test(value)) {
      throw new Error(`${path} must be a valid environment variable name`);
    }
  }

  const timeoutValue = raw.request_timeout_ms;
  if (
    timeoutValue !== undefined &&
    (!Number.isSafeInteger(timeoutValue) ||
      (timeoutValue as number) <= 0 ||
      (timeoutValue as number) > EXTERNAL_LAUNCH_MAX_TIMEOUT_MS)
  ) {
    throw new Error(
      `external_launch.request_timeout_ms must be an integer from 1 to ${EXTERNAL_LAUNCH_MAX_TIMEOUT_MS}`
    );
  }
  let algorithms = parseAlgorithms(raw);
  const allowAdminRoles = optionalBoolean(raw, 'allow_admin_roles');
  const trustVerifiedEmailForLinking = optionalBoolean(raw, 'trust_verified_email_for_linking');
  const forwardRequestHost = optionalBoolean(raw, 'forward_request_host');

  const configuredHeader = requiredString(raw, 'trusted_host_header');
  if (configuredHeader !== undefined && !HTTP_HEADER_NAME.test(configuredHeader)) {
    throw new Error('external_launch.trusted_host_header must be a valid HTTP header name');
  }
  const trustedHostHeader = (
    configuredHeader ?? EXTERNAL_LAUNCH_DEFAULT_TRUSTED_HOST_HEADER
  ).toLowerCase();

  const loginRedirectUrl = httpUrl(
    requiredString(raw, 'login_redirect_url'),
    'external_launch.login_redirect_url'
  );
  const returnHostParamValue = raw.return_host_param;
  if (returnHostParamValue !== undefined && typeof returnHostParamValue !== 'string') {
    throw new Error('external_launch.return_host_param must be a string');
  }
  // Preserve the existing explicit-empty behavior: it selects the default.
  const configuredReturnHostParam = returnHostParamValue?.trim() || undefined;
  if (configuredReturnHostParam === RESERVED_RETURN_TO_PARAM) {
    throw new Error(
      `external_launch.return_host_param must not be "${RESERVED_RETURN_TO_PARAM}" because that name is reserved`
    );
  }
  if (
    configuredReturnHostParam !== undefined &&
    !/^[A-Za-z0-9_.-]+$/.test(configuredReturnHostParam)
  ) {
    throw new Error(
      'external_launch.return_host_param may only contain letters, digits, underscore, hyphen, and dot'
    );
  }

  const verificationMethods = [jwksUrl, publicKey, devSharedSecret].filter(Boolean);
  const requireCompleteProvider = options.requireCompleteProvider ?? true;
  if (requireCompleteProvider && enabled && !exchangeUrl) {
    throw new Error('external_launch.exchange_url is required when external launch is enabled');
  }
  if (requireCompleteProvider && enabled && (!issuer || !audience)) {
    throw new Error(
      'external_launch.issuer and external_launch.audience are required when external launch is enabled'
    );
  }
  if (requireCompleteProvider && enabled && verificationMethods.length === 0) {
    throw new Error('external_launch requires exactly one assertion verification method');
  }
  if (verificationMethods.length > 1) {
    throw new Error('external_launch must not configure multiple assertion verification methods');
  }
  if (publicKey) {
    let key: KeyObject;
    try {
      key = createPublicKey(publicKey);
    } catch {
      throw new Error('external_launch.public_key must be a valid public key');
    }
    algorithms = publicKeyAlgorithms(key, algorithms);
  }
  if (algorithms) {
    const hasHsAlgorithm = algorithms.some((algorithm) => algorithm.startsWith('HS'));
    const hasNonHsAlgorithm = algorithms.some((algorithm) => !algorithm.startsWith('HS'));
    if (devSharedSecret && hasNonHsAlgorithm) {
      throw new Error('external_launch symmetric verification may only use HS* algorithms');
    }
    if ((jwksUrl || publicKey) && hasHsAlgorithm) {
      throw new Error('external_launch asymmetric verification cannot use HS* algorithms');
    }
  }
  if (!algorithms && devSharedSecret) algorithms = DEFAULT_HMAC_ALGORITHMS;
  if (!algorithms && jwksUrl) algorithms = DEFAULT_RSA_ALGORITHMS;

  return {
    enabled,
    exchangeUrl,
    issuer,
    audience,
    instanceId,
    providerId,
    jwksUrl,
    publicKey,
    devSharedSecret,
    serviceCredential,
    allowAdminRoles,
    trustVerifiedEmailForLinking,
    requestTimeoutMs: (timeoutValue as number | undefined) ?? EXTERNAL_LAUNCH_DEFAULT_TIMEOUT_MS,
    algorithms,
    forwardRequestHost,
    trustedHostHeader,
    loginRedirectUrl,
    returnHostParam: loginRedirectUrl
      ? (configuredReturnHostParam ?? EXTERNAL_LAUNCH_DEFAULT_RETURN_HOST_PARAM)
      : undefined,
  };
}

export interface ExternalLaunchSettingsResolution {
  settings: ResolvedExternalLaunchSettings;
  error?: string;
}

const DISABLED_LAUNCH_SETTINGS: ResolvedExternalLaunchSettings = {
  enabled: false,
  allowAdminRoles: false,
  trustVerifiedEmailForLinking: false,
  requestTimeoutMs: EXTERNAL_LAUNCH_DEFAULT_TIMEOUT_MS,
  forwardRequestHost: false,
  trustedHostHeader: EXTERNAL_LAUNCH_DEFAULT_TRUSTED_HOST_HEADER,
};

/**
 * Parse the complete provider profile once through the same fail-closed
 * contract used by startup and request handling. Invalid raw values never
 * escape into auth code as partially trusted settings.
 */
export function resolveExternalLaunchSettings(
  config: AgorConfig
): ExternalLaunchSettingsResolution {
  try {
    return { settings: parseExternalLaunchSettings(config) };
  } catch (error) {
    return {
      settings: DISABLED_LAUNCH_SETTINGS,
      error: error instanceof Error ? error.message : 'external_launch configuration is invalid',
    };
  }
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
  assertValidRawExternalLaunchConfig(configured);

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
 * Validate file- or API-provided values before environment projection. This
 * keeps programmatic daemon startup on the same raw config boundary as YAML
 * loading while allowing required secrets to arrive from their named env vars.
 */
export function assertValidRawExternalLaunchConfig(configured: unknown): void {
  try {
    parseExternalLaunchSettings(
      { external_launch: configured as AgorConfig['external_launch'] },
      { requireCompleteProvider: false }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'external_launch configuration is invalid';
    throw new Error(`Config error: ${message}`);
  }
}

/**
 * Return the single startup/request-time validation result used by both the
 * config boundary and launch service. Keeping this pure prevents the two
 * enforcement points from accepting different provider configurations.
 */
export function externalLaunchConfigurationError(config: AgorConfig): string | undefined {
  return resolveExternalLaunchSettings(config).error;
}

/** Fail startup before database initialization when enabled launch auth is unusable. */
export function assertValidEffectiveExternalLaunchConfig(config: AgorConfig): void {
  const error = externalLaunchConfigurationError(config);
  if (error) throw new Error(`Config error: ${error}`);
}
