/**
 * Deployment-owned guidance shown at the top of the Branch Environment tab.
 *
 * This deliberately is not Markdown. The small, closed shape is enough for
 * operator guidance while avoiding active HTML, rich-content renderers, and
 * arbitrary link protocols in a public `/health` response.
 */

export const ENVIRONMENT_NOTICE_SEVERITIES = ['info', 'success', 'warning', 'error'] as const;
export type EnvironmentNoticeSeverity = (typeof ENVIRONMENT_NOTICE_SEVERITIES)[number];

export const ENVIRONMENT_NOTICE_LIMITS = {
  title: 120,
  message: 2_000,
  linkLabel: 120,
  linkUrl: 2_048,
} as const;

export interface AgorEnvironmentNoticeLinkSettings {
  label: string;
  url: string;
}

/** Raw optional-severity shape accepted in `ui.environment_notice`. */
export interface AgorEnvironmentNoticeSettings {
  severity?: EnvironmentNoticeSeverity;
  title: string;
  message: string;
  link?: AgorEnvironmentNoticeLinkSettings;
}

/** Browser-safe, normalized DTO exposed as `/health.instance.environmentNotice`. */
export interface ResolvedEnvironmentNotice {
  severity: EnvironmentNoticeSeverity;
  title: string;
  message: string;
  link?: AgorEnvironmentNoticeLinkSettings;
}

function requireBoundedText(
  value: unknown,
  path: string,
  maxLength: number,
  options: { multiline?: boolean } = {}
): string {
  if (typeof value !== 'string') {
    throw new Error(`Config error: ${path} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Config error: ${path} must not be empty`);
  if (trimmed.length > maxLength) {
    throw new Error(`Config error: ${path} must be at most ${maxLength} characters`);
  }
  // Newlines are useful in the body, but other control characters have no
  // legitimate display purpose and can make diagnostics or copied YAML
  // misleading. Titles and labels remain single-line.
  const hasForbiddenControl = [...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    if (options.multiline && (code === 9 || code === 10 || code === 13)) return false;
    return code <= 31 || code === 127;
  });
  if (hasForbiddenControl) {
    throw new Error(
      `Config error: ${path} must not contain ${options.multiline ? 'unsupported control characters' : 'line breaks or control characters'}`
    );
  }
  return trimmed;
}

function requireSafeDocsUrl(value: unknown, path: string): string {
  const url = requireBoundedText(value, path, ENVIRONMENT_NOTICE_LIMITS.linkUrl);
  if (url.includes('\\')) {
    throw new Error(`Config error: ${path} must not contain backslashes`);
  }

  // A single-slash path is same-origin. Protocol-relative URLs are excluded.
  if (url.startsWith('/') && !url.startsWith('//')) {
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Config error: ${path} must be an HTTPS URL or a same-origin path beginning with /`
    );
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error(
      `Config error: ${path} must be an HTTPS URL or a same-origin path beginning with /`
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Config error: ${path} must not include URL credentials`);
  }
  return url;
}

/** Validate and project the deployment setting into its public DTO. */
export function resolveEnvironmentNotice(
  value: AgorEnvironmentNoticeSettings | undefined
): ResolvedEnvironmentNotice | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Config error: ui.environment_notice must be a mapping');
  }

  const raw = value as unknown as Record<string, unknown>;
  const severity = raw.severity ?? 'info';
  if (
    typeof severity !== 'string' ||
    !ENVIRONMENT_NOTICE_SEVERITIES.includes(severity as EnvironmentNoticeSeverity)
  ) {
    throw new Error(
      'Config error: ui.environment_notice.severity must be one of: info, success, warning, error'
    );
  }

  const notice: ResolvedEnvironmentNotice = {
    severity: severity as EnvironmentNoticeSeverity,
    title: requireBoundedText(
      raw.title,
      'ui.environment_notice.title',
      ENVIRONMENT_NOTICE_LIMITS.title
    ),
    message: requireBoundedText(
      raw.message,
      'ui.environment_notice.message',
      ENVIRONMENT_NOTICE_LIMITS.message,
      { multiline: true }
    ),
  };

  if (raw.link !== undefined) {
    if (!raw.link || typeof raw.link !== 'object' || Array.isArray(raw.link)) {
      throw new Error('Config error: ui.environment_notice.link must be a mapping');
    }
    const link = raw.link as Record<string, unknown>;
    notice.link = {
      label: requireBoundedText(
        link.label,
        'ui.environment_notice.link.label',
        ENVIRONMENT_NOTICE_LIMITS.linkLabel
      ),
      url: requireSafeDocsUrl(link.url, 'ui.environment_notice.link.url'),
    };
  }

  return notice;
}
