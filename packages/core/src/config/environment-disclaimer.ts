/** Operator-authored Markdown shown on every Branch Environment tab. */

export const ENVIRONMENT_DISCLAIMER_MARKDOWN_MAX_LENGTH = 8_000;

const INLINE_LINK_DESTINATION = /!?(?:\[[^\]]*\])\(\s*<?([^\s)>]+)>?/g;
const REFERENCE_LINK_DESTINATION = /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm;
const AUTOLINK_DESTINATION = /<((?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)[^>\s]+)>/g;

/**
 * Disclaimer links are intentionally narrower than general conversation
 * Markdown: HTTPS documentation URLs and same-origin absolute paths only.
 */
export function isSafeEnvironmentDisclaimerUrl(value: string): boolean {
  if (!value || value.includes('\\')) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateLinkDestinations(markdown: string): void {
  for (const pattern of [
    INLINE_LINK_DESTINATION,
    REFERENCE_LINK_DESTINATION,
    AUTOLINK_DESTINATION,
  ]) {
    pattern.lastIndex = 0;
    for (const match of markdown.matchAll(pattern)) {
      const destination = match[1];
      if (destination && !isSafeEnvironmentDisclaimerUrl(destination)) {
        throw new Error(
          'Config error: ui.environment_disclaimer_markdown links must use HTTPS or a same-origin path beginning with /'
        );
      }
    }
  }
}

/** Validate and normalize public operator content at config load time. */
export function resolveEnvironmentDisclaimerMarkdown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('Config error: ui.environment_disclaimer_markdown must be a string');
  }
  const markdown = value.trim();
  if (!markdown) {
    throw new Error('Config error: ui.environment_disclaimer_markdown must not be empty');
  }
  if (markdown.length > ENVIRONMENT_DISCLAIMER_MARKDOWN_MAX_LENGTH) {
    throw new Error(
      `Config error: ui.environment_disclaimer_markdown must be at most ${ENVIRONMENT_DISCLAIMER_MARKDOWN_MAX_LENGTH} characters`
    );
  }
  if (/!\s*\[/.test(markdown)) {
    throw new Error('Config error: ui.environment_disclaimer_markdown does not support images');
  }
  const hasForbiddenControl = [...markdown].some((character) => {
    const code = character.charCodeAt(0);
    return code !== 9 && code !== 10 && code !== 13 && (code <= 31 || code === 127);
  });
  if (hasForbiddenControl) {
    throw new Error(
      'Config error: ui.environment_disclaimer_markdown must not contain unsupported control characters'
    );
  }
  validateLinkDestinations(markdown);
  return markdown;
}
