import { stripVTControlCharacters } from 'node:util';
import { redactGitUrlCredentials, type UserGitEnvironment } from '@agor/git/pure';

/** Bounded, credential-redacted stderr for clone persistence, logs and IPC. */
export function cloneDiagnostic(message: string, env: UserGitEnvironment = {}): string {
  let safe = stripVTControlCharacters(message)
    .replace(/\r\n?/g, '\n')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (url) =>
      redactGitUrlCredentials(url).replace(/[?#].*$/, '?<redacted>')
    );
  // Redact before truncation so neither a split URL nor a partial token survives.
  for (const token of [env.GITHUB_TOKEN, env.GH_TOKEN]) {
    if (!token) continue;
    for (const value of [token, Buffer.from(`x-access-token:${token}`).toString('base64')]) {
      safe = safe.split(value).join('<redacted>');
    }
  }
  safe = safe.replace(/((?:proxy-)?authorization\s*:\s*)[^\r\n]+/gi, '$1<redacted>').trim();
  // Git's actionable remote/fatal lines follow its progress output. Preserve
  // the tail, not only "Cloning into ...", even after a long transfer (#2642).
  const limit = 4000;
  const marker = '[earlier output truncated]\n';
  return safe.length > limit ? marker + safe.slice(-(limit - marker.length)) : safe;
}
