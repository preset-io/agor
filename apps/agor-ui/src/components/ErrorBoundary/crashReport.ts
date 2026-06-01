// Pure helpers that assemble a UI-crash report from an Error + React
// ErrorInfo. Split out from the component so they're easy to unit test
// without rendering anything.

import type { ErrorInfo } from 'react';
import { getCrashContext } from './crashContext';

export const GITHUB_NEW_ISSUE_URL = 'https://github.com/preset-io/agor/issues/new';

// Keep the GitHub issue URL well under common ~8KB browser limits — GitHub
// silently truncates very long URLs. URL-encoding roughly triples raw size,
// so we cap the markdown body around 4KB before encoding.
export const MAX_GITHUB_BODY_CHARS = 4000;

export function firstComponentFromStack(componentStack: string | null | undefined): string {
  if (!componentStack) return 'unknown component';
  // componentStack lines look like "    in MyComponent (at file.tsx:42)" —
  // pull the first identifier following "in ".
  const match = componentStack.match(/in\s+([A-Za-z0-9_$.]+)/);
  return match?.[1] ?? 'unknown component';
}

interface BuildReportEnv {
  now?: Date;
  href?: string;
  userAgent?: string;
}

export function buildMarkdownReport(
  error: Error,
  errorInfo: ErrorInfo | null,
  env: BuildReportEnv = {}
): string {
  const { buildSha, userEmail } = getCrashContext();
  const when = (env.now ?? new Date()).toISOString();
  const where = env.href ?? (typeof window !== 'undefined' ? window.location.href : 'unknown');
  const ua = env.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown');
  const component = firstComponentFromStack(errorInfo?.componentStack);

  return [
    '## UI crash report',
    '',
    `- **When:** ${when}`,
    `- **Where:** ${where}`,
    `- **Component:** ${component}`,
    `- **User:** ${userEmail ?? '(not signed in)'}`,
    `- **Build:** ${buildSha ?? 'unknown'}`,
    `- **Browser:** ${ua}`,
    `- **Error:** ${error.message || String(error)}`,
    '',
    '### Component stack',
    '```',
    (errorInfo?.componentStack ?? '(unavailable)').trim(),
    '```',
    '',
    '### Error stack',
    '```',
    (error.stack ?? '(unavailable)').trim(),
    '```',
    '',
  ].join('\n');
}

export function buildGitHubIssueUrl(
  error: Error,
  errorInfo: ErrorInfo | null,
  env: BuildReportEnv = {}
): string {
  const component = firstComponentFromStack(errorInfo?.componentStack);
  const title = `UI crash: ${component} — ${error.message?.slice(0, 80) ?? 'unknown error'}`;
  let body = buildMarkdownReport(error, errorInfo, env);
  if (body.length > MAX_GITHUB_BODY_CHARS) {
    body = `${body.slice(0, MAX_GITHUB_BODY_CHARS)}\n\n_(truncated — see full report copied to clipboard)_`;
  }
  const params = new URLSearchParams({ title, body, labels: 'bug' });
  return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
}
