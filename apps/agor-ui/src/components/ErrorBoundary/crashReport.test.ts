import type { ErrorInfo } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { setCrashContext } from './crashContext';
import {
  buildGitHubIssueUrl,
  buildMarkdownReport,
  firstComponentFromStack,
  GITHUB_NEW_ISSUE_URL,
  MAX_GITHUB_BODY_CHARS,
} from './crashReport';

const sampleStack = `
    in BoardCanvas (at BoardCanvas.tsx:42)
    in Suspense
    in AppContent (at App.tsx:96)
`;
const env = {
  now: new Date('2026-05-15T05:18:00Z'),
  href: 'http://localhost:5173/b/abc/sess1/',
  userAgent: 'Mozilla/5.0 (test)',
};

beforeEach(() => {
  setCrashContext({ buildSha: 'cace77e4', userEmail: 'max@preset.io' });
});

describe('firstComponentFromStack', () => {
  it('returns the first component name from a React component stack', () => {
    expect(firstComponentFromStack(sampleStack)).toBe('BoardCanvas');
  });

  it('falls back to a placeholder for empty / missing stacks', () => {
    expect(firstComponentFromStack(null)).toBe('unknown component');
    expect(firstComponentFromStack(undefined)).toBe('unknown component');
    expect(firstComponentFromStack('')).toBe('unknown component');
    expect(firstComponentFromStack('garbage with no in-token')).toBe('unknown component');
  });
});

describe('buildMarkdownReport', () => {
  it('includes timestamp, location, user, build, browser, and message', () => {
    const error = new Error('boom');
    const info: ErrorInfo = { componentStack: sampleStack, digest: null };
    const md = buildMarkdownReport(error, info, env);

    expect(md).toContain('## UI crash report');
    expect(md).toContain('**When:** 2026-05-15T05:18:00.000Z');
    expect(md).toContain('**Where:** http://localhost:5173/b/abc/sess1/');
    expect(md).toContain('**Component:** BoardCanvas');
    expect(md).toContain('**User:** max@preset.io');
    expect(md).toContain('**Build:** cace77e4');
    expect(md).toContain('**Browser:** Mozilla/5.0 (test)');
    expect(md).toContain('**Error:** boom');
    expect(md).toContain('### Component stack');
    expect(md).toContain('### Error stack');
  });

  it('uses placeholders when crash context is unset', () => {
    setCrashContext({ buildSha: null, userEmail: null });
    const md = buildMarkdownReport(new Error('x'), null, env);
    expect(md).toContain('**User:** (not signed in)');
    expect(md).toContain('**Build:** unknown');
    expect(md).toContain('**Component:** unknown component');
  });
});

describe('buildGitHubIssueUrl', () => {
  it('points at preset-io/agor with title, body, and bug label', () => {
    const url = buildGitHubIssueUrl(
      new Error('boom'),
      { componentStack: sampleStack, digest: null },
      env
    );
    expect(url.startsWith(`${GITHUB_NEW_ISSUE_URL}?`)).toBe(true);

    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe('UI crash: BoardCanvas — boom');
    expect(params.get('labels')).toBe('bug');
    expect(params.get('body')).toContain('## UI crash report');
  });

  it('truncates oversized bodies and notes the truncation', () => {
    const huge = 'x'.repeat(20_000);
    const error = new Error(huge);
    const url = buildGitHubIssueUrl(error, { componentStack: sampleStack, digest: null }, env);
    const body = new URL(url).searchParams.get('body') ?? '';
    expect(body.length).toBeLessThanOrEqual(MAX_GITHUB_BODY_CHARS + 100);
    expect(body).toContain('truncated');
  });
});
