import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCodexAuthJson, readCodexAuthFile, writeCodexAuthFile } from './codex-auth-file';

/** Build an unsigned JWT with the given payload — enough for claim mining. */
function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(payload)}.signature`;
}

const CHATGPT_AUTH_JSON = {
  OPENAI_API_KEY: null,
  tokens: {
    id_token: fakeJwt({
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-1' },
    }),
    access_token: 'access-abc',
    refresh_token: 'refresh-xyz',
    account_id: 'acct-1',
  },
  last_refresh: '2026-07-16T12:00:00.000000Z',
};

describe('parseCodexAuthJson', () => {
  it('rejects empty and whitespace-only input', () => {
    for (const raw of ['', '   \n ', undefined, null]) {
      const result = parseCodexAuthJson(raw);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects non-JSON input with a friendly error that never echoes the input', () => {
    const result = parseCodexAuthJson('sk-proj-not-json-at-all');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('cat ~/.codex/auth.json');
      expect(result.error).not.toContain('sk-proj');
    }
  });

  it('rejects JSON that is not an object', () => {
    expect(parseCodexAuthJson('[1,2,3]').ok).toBe(false);
    expect(parseCodexAuthJson('"a string"').ok).toBe(false);
  });

  it('rejects an object with neither login tokens nor an API key', () => {
    const result = parseCodexAuthJson(
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'x' } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('codex login');
  });

  it('rejects a whitespace-only refresh token — not a usable credential', () => {
    const result = parseCodexAuthJson(
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { refresh_token: '   ' } })
    );
    expect(result.ok).toBe(false);
  });

  it('rejects oversized payloads', () => {
    const huge = JSON.stringify({ OPENAI_API_KEY: 'x'.repeat(70 * 1024) });
    expect(parseCodexAuthJson(huge).ok).toBe(false);
  });

  it('accepts a ChatGPT login file and mines plan type from the id_token', () => {
    const result = parseCodexAuthJson(JSON.stringify(CHATGPT_AUTH_JSON));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.authMode).toBe('chatgpt');
      expect(result.summary.planType).toBe('plus');
      expect(result.summary.lastRefresh).toBe('2026-07-16T12:00:00.000000Z');
      expect(result.summary.apiKey).toBeUndefined();
    }
  });

  it('tolerates an unparseable id_token — plan type is best-effort display data', () => {
    const withBadIdToken = {
      ...CHATGPT_AUTH_JSON,
      tokens: { ...CHATGPT_AUTH_JSON.tokens, id_token: 'not-a-jwt' },
    };
    const result = parseCodexAuthJson(JSON.stringify(withBadIdToken));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.authMode).toBe('chatgpt');
      expect(result.summary.planType).toBeUndefined();
    }
  });

  it('accepts an API-key-only file', () => {
    const result = parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: 'sk-proj-123' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.authMode).toBe('api_key');
      expect(result.summary.apiKey).toBe('sk-proj-123');
    }
  });

  it('round-trips unknown fields — Codex owns this schema', () => {
    const withExtras = { ...CHATGPT_AUTH_JSON, auth_mode: 'chatgpt', future_field: { a: 1 } };
    const result = parseCodexAuthJson(JSON.stringify(withExtras));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.normalized)).toEqual(withExtras);
      expect(result.normalized.endsWith('\n')).toBe(true);
    }
  });
});

describe('readCodexAuthFile (daemon-user path)', () => {
  // The daemon-user branch honors $CODEX_HOME, which lets these tests point
  // it at a throwaway directory.
  const originalCodexHome = process.env.CODEX_HOME;
  let tmpHome: string;

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function useTmpCodexHome(): string {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-test-'));
    process.env.CODEX_HOME = tmpHome;
    return tmpHome;
  }

  it('returns the file content when present', () => {
    const home = useTmpCodexHome();
    fs.writeFileSync(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"sk-x"}');
    expect(readCodexAuthFile(null)).toEqual({ ok: true, content: '{"OPENAI_API_KEY":"sk-x"}' });
  });

  it('distinguishes a genuinely absent file (not-found) from other failures', () => {
    useTmpCodexHome();
    expect(readCodexAuthFile(null)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('reports unreadable (not not-found) when the path exists but cannot be read as a file', () => {
    const home = useTmpCodexHome();
    fs.mkdirSync(path.join(home, 'auth.json'));
    expect(readCodexAuthFile(null)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('write round-trips exactly and leaves no staging files behind', () => {
    const home = useTmpCodexHome();
    writeCodexAuthFile('{"OPENAI_API_KEY":"sk-first"}\n', null);
    writeCodexAuthFile('{"OPENAI_API_KEY":"sk-second"}\n', null);
    expect(readCodexAuthFile(null)).toEqual({
      ok: true,
      content: '{"OPENAI_API_KEY":"sk-second"}\n',
    });
    expect(fs.readdirSync(home)).toEqual(['auth.json']);
  });
});
