/**
 * Mention detection for board comments. The comment editor inserts a user as
 * `@<name or email>` (bare) and users may also type the quoted `@"<handle>"` form.
 */

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let cached: { key: string; pattern: RegExp | null } | undefined;

/**
 * Whether comment text @-mentions the user by display name or email, bare or
 * quoted, ignoring case. A bare handle must not run on into a letter, digit or
 * underscore in any script, so `@Al` does not match `@Alice` and `@Zo` not `@Zoë`.
 */
export function commentMentionsUser(
  content: string,
  userName?: string,
  userEmail?: string
): boolean {
  const key = `${userName ?? ''}\n${userEmail ?? ''}`;
  if (cached?.key !== key) {
    const handles = [userName, userEmail].filter(Boolean).map((h) => escapeRegex(h as string));
    const alternation = handles.join('|');
    cached = {
      key,
      pattern: handles.length
        ? new RegExp(`@(?:"(?:${alternation})"|(?:${alternation})(?![\\p{L}\\p{M}\\p{N}_]))`, 'iu')
        : null,
    };
  }
  return cached.pattern?.test(content) ?? false;
}
