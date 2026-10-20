import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as SDK from '@google/gemini-cli-core';
import { describe, expect, it, vi } from 'vitest';
import {
  enterGeminiRuntime,
  findGeminiRecording,
  GEMINI_RESET_HISTORY_FOR,
  GeminiIntegrationError,
  geminiError,
  geminiFailureLine,
  geminiSessionId,
} from './runtime.js';

describe('fixed Gemini errors', () => {
  it.each([
    [
      { status: 400, message: 'API_KEY_INVALID SECRET' },
      'Gemini rejected the API key. Check it in Settings → Gemini.',
    ],
    [
      { status: 401, message: 'SECRET' },
      'Gemini rejected the API key. Check it in Settings → Gemini.',
    ],
    [{ status: 403 }, 'Gemini rejected the API key. Check it in Settings → Gemini.'],
    [{ status: 404 }, "Model test isn't available to this API key. Pick another Gemini model."],
    [
      { name: 'TerminalQuotaError', status: 429 },
      "This API key's plan or quota doesn't allow this request.",
    ],
    [
      { status: 429, message: 'RetryInfo SECRET' },
      'Gemini is busy or rate-limited. Try again shortly.',
    ],
    [{ status: 503 }, 'Gemini is busy or rate-limited. Try again shortly.'],
    [{ status: 500 }, 'Gemini API error. Try again later.'],
    [{ message: 'fetch failed SECRET' }, 'Could not reach the Gemini API.'],
    [{ message: 'SECRET' }, 'Gemini integration error.'],
  ])('maps without reflecting provider text', (error, expected) => {
    expect(geminiError({ error }, 'test').message).toBe(expected);
    expect(geminiError(error, 'test').message).not.toContain('SECRET');
  });
  it('preserves only integration-owned errors', () => {
    const error = new GeminiIntegrationError('fixed error');
    expect(geminiError(error, 'test')).toBe(error);
  });
  it('does not share SDK filename prefixes for same-minute sessions', () => {
    const a = geminiSessionId('019f0000-1234-7000-8000-000000000001');
    const b = geminiSessionId('019f0000-1234-7000-8000-000000000002');
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8));
    expect(geminiSessionId('same')).toBe(geminiSessionId('same'));
  });
});

it('uses the delegated executor HOME when no Gemini home override is projected', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-delegated-home-'));
  const previous = {
    HOME: process.env.HOME,
    GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME,
    AGOR_EXECUTOR_SCRATCH_ROOT: process.env.AGOR_EXECUTOR_SCRATCH_ROOT,
  };
  try {
    process.env.HOME = home;
    delete process.env.GEMINI_CLI_HOME;
    delete process.env.AGOR_EXECUTOR_SCRATCH_ROOT;
    const cleanup = await enterGeminiRuntime();
    try {
      expect(process.env.TMPDIR).toContain(path.join(home, '.gemini', 'agor-task-tmp'));
    } finally {
      await cleanup();
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
});

describe('executor scratch for task temp', () => {
  const keys = ['HOME', 'GEMINI_CLI_HOME', 'AGOR_EXECUTOR_SCRATCH_ROOT', 'TMPDIR'] as const;
  const restore = (previous: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  it('keeps task temp on launcher scratch instead of the SDK home', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-scratch-home-'));
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-scratch-root-'));
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.HOME = home;
      delete process.env.GEMINI_CLI_HOME;
      process.env.AGOR_EXECUTOR_SCRATCH_ROOT = scratch;
      const cleanup = await enterGeminiRuntime();
      let temp: string | undefined;
      try {
        temp = process.env.TMPDIR;
        expect(temp?.startsWith(path.join(scratch, 'gemini-task-tmp') + path.sep)).toBe(true);
        await expect(fs.stat(path.join(home, '.gemini', 'agor-task-tmp'))).rejects.toThrow();
      } finally {
        await cleanup();
      }
      await expect(fs.stat(temp!)).rejects.toThrow();
      expect(process.env.TMPDIR).toBe(previous.TMPDIR);
    } finally {
      restore(previous);
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it.each(['relative/scratch', '   '])(
    'refuses a non-absolute scratch path %j instead of falling back',
    async (value) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-scratch-home-'));
      const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      try {
        process.env.HOME = home;
        delete process.env.GEMINI_CLI_HOME;
        process.env.AGOR_EXECUTOR_SCRATCH_ROOT = value;
        await expect(enterGeminiRuntime()).rejects.toBeInstanceOf(GeminiIntegrationError);
        expect(process.env.TMPDIR).toBe(previous.TMPDIR);
        await expect(fs.stat(path.join(home, '.gemini', 'agor-task-tmp'))).rejects.toThrow();
      } finally {
        restore(previous);
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  );
});

it('quarantines ambiguous recordings only for an explicit matching session reset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-recordings-'));
  const chats = path.join(root, 'chats');
  const priorReset = process.env[GEMINI_RESET_HISTORY_FOR];
  await fs.mkdir(chats);
  const first = path.join(chats, 'session-first.jsonl');
  const second = path.join(chats, 'session-second.jsonl');
  const damaged = path.join(chats, 'session-damaged.jsonl');
  await Promise.all([
    fs.writeFile(first, '{}'),
    fs.writeFile(second, '{}'),
    fs.writeFile(damaged, '{'),
  ]);
  const sdk = {
    loadConversationRecord: vi.fn(async (file: string) => {
      if (file === damaged) throw new Error('damaged private recording');
      return { sessionId: 'sdk-id', hasResumableContent: true };
    }),
  } as unknown as typeof SDK;
  const config = { storage: { getProjectTempDir: () => root } } as unknown as SDK.Config;
  try {
    delete process.env[GEMINI_RESET_HISTORY_FOR];
    await expect(findGeminiRecording(sdk, config, 'sdk-id')).rejects.toThrow(
      'Multiple Gemini recordings'
    );
    expect(await fs.readdir(chats)).toHaveLength(3);
    process.env[GEMINI_RESET_HISTORY_FOR] = 'sdk-id';
    await expect(findGeminiRecording(sdk, config, 'sdk-id', 'agor-id')).rejects.toThrow(
      'Multiple Gemini recordings'
    );
    process.env[GEMINI_RESET_HISTORY_FOR] = 'agor-id';
    expect(await findGeminiRecording(sdk, config, 'sdk-id', 'agor-id')).toBeUndefined();
    const entries = await fs.readdir(chats);
    expect(entries).toHaveLength(2);
    const quarantine = entries.find((name) => name.startsWith('.agor-quarantine-'))!;
    expect((await fs.readdir(path.join(chats, quarantine))).sort()).toEqual([
      'session-first.jsonl',
      'session-second.jsonl',
    ]);
    await fs.writeFile(first, '{}');
    expect(await findGeminiRecording(sdk, config, 'sdk-id', 'agor-id')).toBe(first);
  } finally {
    if (priorReset === undefined) delete process.env[GEMINI_RESET_HISTORY_FOR];
    else process.env[GEMINI_RESET_HISTORY_FOR] = priorReset;
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('Gemini failure fields', () => {
  it('records authentication and the HTTP status for a 401', () => {
    const error = geminiError({ status: 401, message: 'SECRET' }, 'test');
    expect(error).toMatchObject({ category: 'authentication', httpStatus: 401 });
    expect(geminiFailureLine('generation', error)).toBe(
      '[gemini.failure] stage=generation category=authentication http_status=401'
    );
  });

  it('records quota and the allowlisted class for a TerminalQuotaError', () => {
    class TerminalQuotaError extends Error {
      override name = 'TerminalQuotaError';
    }
    const error = geminiError(new TerminalQuotaError('SECRET quota detail'), 'test');
    expect(error).toMatchObject({ category: 'quota', errorClass: 'TerminalQuotaError' });
    expect(geminiFailureLine('generation', error)).toBe(
      '[gemini.failure] stage=generation category=quota error_class=TerminalQuotaError'
    );
  });

  it('drops a class name that is not allowlisted', () => {
    class SecretLeakingError extends Error {
      override name = 'SecretLeakingError';
    }
    const error = geminiError(Object.assign(new SecretLeakingError('x'), { status: 503 }), 'test');
    expect(error).toMatchObject({ category: 'busy', httpStatus: 503 });
    expect(error.errorClass).toBeUndefined();
    expect(geminiFailureLine('stream', error)).not.toContain('SecretLeakingError');
  });

  it('logs the same line for the same status and class whatever the provider text', () => {
    const shapes: Array<[Record<string, unknown>, string]> = [
      [{ status: 400 }, 'category=unknown http_status=400'],
      [{ status: 403 }, 'category=authentication http_status=403'],
      [{ status: 404 }, 'category=model_unavailable http_status=404'],
      [{ status: 429 }, 'category=busy http_status=429'],
      [
        { status: 429, name: 'TerminalQuotaError' },
        'category=quota http_status=429 error_class=TerminalQuotaError',
      ],
      [{ status: 500 }, 'category=provider_error http_status=500'],
      [{ code: 'ECONNREFUSED' }, 'category=network'],
      [{}, 'category=unknown'],
    ];
    const bodies = [
      'API key not valid. API_KEY_INVALID terms of service model not found retryDelay fetch failed',
      'SECRET unrelated provider detail',
    ];
    for (const [shape, fields] of shapes) {
      const lines = bodies.map((message) =>
        geminiFailureLine('generation', geminiError({ ...shape, message }, 'test'))
      );
      expect(lines[0]).toBe(`[gemini.failure] stage=generation ${fields}`);
      expect(lines[1]).toBe(lines[0]);
    }
  });

  it('reads a network code from a fetch failure cause', () => {
    const error = geminiError(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
      }),
      'test'
    );
    expect(error.message).toBe('Could not reach the Gemini API.');
    expect(error.category).toBe('network');
  });

  it('labels fixed integration and local failures without provider fields', () => {
    expect(geminiFailureLine('preflight', new GeminiIntegrationError('fixed'))).toBe(
      '[gemini.failure] stage=preflight category=integration'
    );
    expect(geminiFailureLine('persistence', new Error('SECRET'))).toBe(
      '[gemini.failure] stage=persistence category=local'
    );
  });
});
