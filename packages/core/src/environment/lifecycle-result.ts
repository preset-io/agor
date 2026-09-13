import { isAllowedFactProbeUrl, isPublicHttpUrl } from '../utils/url';

export const ENVIRONMENT_LIFECYCLE_RESULT_VERSION = 1 as const;
export const ENVIRONMENT_LIFECYCLE_RESULT_PREFIX = 'AGOR_ENVIRONMENT_RESULT=';
export const ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE = 'ENVIRONMENT_LIFECYCLE_SUPERSEDED';
export const ENVIRONMENT_LIFECYCLE_RESULT_MAX_BYTES = 8 * 1024;
export const ENVIRONMENT_LIFECYCLE_RESULT_MAX_ACCESS_URLS = 8;

export interface EnvironmentLifecycleAccessUrl {
  /** Human-readable, unique label. The first entry is the primary application URL. */
  name: string;
  url: string;
}

export interface EnvironmentLifecycleResource {
  /** Provider family, for example `github-codespaces`. Never contains a credential. */
  provider?: string;
  /** Opaque immutable provider identifier when one exists. */
  id?: string;
  /** Provider display/resource name used by repository lifecycle templates. */
  name?: string;
  /** Human-facing provider management page. */
  manage_url?: string;
}

/**
 * Versioned, deliberately bounded output from a managed-environment lifecycle command.
 *
 * This is persisted runtime metadata, never a secret transport. URLs reject
 * userinfo/query/fragment components and every string and collection is bounded.
 */
export interface EnvironmentLifecycleResult {
  version: typeof ENVIRONMENT_LIFECYCLE_RESULT_VERSION;
  access_urls?: EnvironmentLifecycleAccessUrl[];
  health_url?: string;
  resource?: EnvironmentLifecycleResource;
  /** Exact Git commit a source synchronization command actually applied. */
  applied_revision?: string;
}

const RESULT_KEYS = new Set([
  'version',
  'access_urls',
  'health_url',
  'resource',
  'applied_revision',
]);
const ACCESS_URL_KEYS = new Set(['name', 'url']);
const RESOURCE_KEYS = new Set(['provider', 'id', 'name', 'manage_url']);

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(record: Record<string, unknown>, keys: Set<string>, label: string): void {
  if (Object.keys(record).some((key) => !keys.has(key))) {
    throw new Error(`${label} contains an unsupported field`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function normalizeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || hasControlCharacter(normalized)) {
    throw new Error(`${label} must be a non-empty bounded text value`);
  }
  return normalized;
}

/** Validate a full canonical SHA-1 or SHA-256 Git object ID. */
export function validateEnvironmentSourceRevision(
  value: unknown,
  label = 'environment source revision'
): string {
  const revision = normalizeText(value, label, 64);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) {
    throw new Error(`${label} must be a full lowercase Git SHA-1 or SHA-256 object ID`);
  }
  return revision;
}

function normalizeLifecycleUrl(value: unknown, label: string): string {
  const raw = normalizeText(value, label, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return parsed.toString();
}

function validateAccessUrls(value: unknown): EnvironmentLifecycleAccessUrl[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('environment result access_urls must be a non-empty array');
  }
  if (value.length > ENVIRONMENT_LIFECYCLE_RESULT_MAX_ACCESS_URLS) {
    throw new Error('environment result contains too many access URLs');
  }
  const names = new Set<string>();
  return value.map((entry, index) => {
    const record = assertPlainObject(entry, `environment result access_urls[${index}]`);
    assertOnlyKeys(record, ACCESS_URL_KEYS, `environment result access_urls[${index}]`);
    const name = normalizeText(record.name, `environment result access_urls[${index}].name`, 64);
    const identity = name.toLocaleLowerCase('en-US');
    if (names.has(identity)) throw new Error('environment result access URL names must be unique');
    names.add(identity);
    return {
      name,
      url: normalizeLifecycleUrl(record.url, `environment result access_urls[${index}].url`),
    };
  });
}

function validateResource(value: unknown): EnvironmentLifecycleResource {
  const record = assertPlainObject(value, 'environment result resource');
  assertOnlyKeys(record, RESOURCE_KEYS, 'environment result resource');
  const result: EnvironmentLifecycleResource = {};
  if (Object.hasOwn(record, 'provider')) {
    result.provider = normalizeText(record.provider, 'environment result resource.provider', 128);
  }
  if (Object.hasOwn(record, 'id')) {
    result.id = normalizeText(record.id, 'environment result resource.id', 256);
  }
  if (Object.hasOwn(record, 'name')) {
    result.name = normalizeText(record.name, 'environment result resource.name', 256);
  }
  if (Object.hasOwn(record, 'manage_url')) {
    result.manage_url = normalizeLifecycleUrl(
      record.manage_url,
      'environment result resource.manage_url'
    );
  }
  if (Object.keys(result).length === 0) {
    throw new Error('environment result resource must contain at least one field');
  }
  return result;
}

/** Validate and normalize a complete lifecycle result. Unknown fields fail closed. */
export function validateEnvironmentLifecycleResult(value: unknown): EnvironmentLifecycleResult {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('environment result must be JSON serializable');
  }
  if (Buffer.byteLength(encoded ?? '', 'utf8') > ENVIRONMENT_LIFECYCLE_RESULT_MAX_BYTES) {
    throw new Error('environment result exceeds the size limit');
  }

  const record = assertPlainObject(value, 'environment result');
  assertOnlyKeys(record, RESULT_KEYS, 'environment result');
  if (record.version !== ENVIRONMENT_LIFECYCLE_RESULT_VERSION) {
    throw new Error(`environment result version must be ${ENVIRONMENT_LIFECYCLE_RESULT_VERSION}`);
  }

  return {
    version: ENVIRONMENT_LIFECYCLE_RESULT_VERSION,
    ...(Object.hasOwn(record, 'access_urls')
      ? { access_urls: validateAccessUrls(record.access_urls) }
      : {}),
    ...(Object.hasOwn(record, 'health_url')
      ? { health_url: normalizeLifecycleUrl(record.health_url, 'environment result health_url') }
      : {}),
    ...(Object.hasOwn(record, 'resource') ? { resource: validateResource(record.resource) } : {}),
    ...(Object.hasOwn(record, 'applied_revision')
      ? {
          applied_revision: validateEnvironmentSourceRevision(
            record.applied_revision,
            'environment result applied_revision'
          ),
        }
      : {}),
  };
}

/** Dynamic health is provider output, so it must be public before DNS pinning at connect time. */
export function isAllowedDynamicEnvironmentHealthUrl(value: string): boolean {
  try {
    return isPublicHttpUrl(normalizeLifecycleUrl(value, 'environment result health_url'));
  } catch {
    return false;
  }
}

export interface EnvironmentHealthTargetInput {
  /** Operator-authored target; local/private destinations are allowed. */
  configuredHealthUrl?: string;
  /** Current typed provider result. This deliberately shadows legacy output. */
  lifecycleResultHealthUrl?: string;
  /** Transitional provider output retained for already-running environments. */
  legacyFactHealthUrl?: string;
}

export interface EnvironmentHealthTargetSelection {
  /** Present even when rejected, so callers can explain why health is unobservable. */
  rawDynamicHealthUrl?: string;
  /** Target the daemon will actually evaluate. */
  healthUrl?: string;
  /** Whether the selected target requires the DNS-pinned public fetch path. */
  isDynamicHealth: boolean;
}

/** Shared daemon/UI selection rules for configured and provider-reported health targets. */
export function resolveEnvironmentHealthTarget(
  input: EnvironmentHealthTargetInput
): EnvironmentHealthTargetSelection {
  const rawDynamicHealthUrl = input.lifecycleResultHealthUrl ?? input.legacyFactHealthUrl;
  // A typed result is authoritative when present. Never fall back to legacy
  // facts merely because the typed value fails validation.
  const dynamicHealthUrl = input.lifecycleResultHealthUrl
    ? isAllowedDynamicEnvironmentHealthUrl(input.lifecycleResultHealthUrl)
      ? input.lifecycleResultHealthUrl
      : undefined
    : input.legacyFactHealthUrl && isAllowedFactProbeUrl(input.legacyFactHealthUrl)
      ? input.legacyFactHealthUrl
      : undefined;
  const healthUrl = input.configuredHealthUrl || dynamicHealthUrl;
  return {
    rawDynamicHealthUrl,
    healthUrl,
    isDynamicHealth: !input.configuredHealthUrl && dynamicHealthUrl !== undefined,
  };
}

/**
 * Compatibility context for existing `{{env.*}}` lifecycle templates.
 * Only named, bounded protocol fields are exposed; this is not an arbitrary fact bag.
 */
export function lifecycleResultTemplateFacts(
  result: EnvironmentLifecycleResult | undefined
): Record<string, string> {
  if (!result) return {};
  const primaryUrl = result.access_urls?.[0]?.url;
  const facts: Record<string, string> = {
    ...(primaryUrl ? { url: primaryUrl } : {}),
    ...(result.health_url ? { health: result.health_url } : {}),
    ...(result.resource?.name ? { name: result.resource.name } : {}),
    ...(result.resource?.id ? { resource_id: result.resource.id } : {}),
    ...(result.resource?.provider ? { resource_provider: result.resource.provider } : {}),
    ...(result.resource?.manage_url ? { manage_url: result.resource.manage_url } : {}),
    ...(result.applied_revision ? { applied_revision: result.applied_revision } : {}),
  };
  for (const accessUrl of result.access_urls?.slice(1) ?? []) {
    const slug = accessUrl.name
      .toLocaleLowerCase('en-US')
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
    if (slug) facts[`url_${slug}`] = accessUrl.url;
  }
  return facts;
}
