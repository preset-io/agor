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
  const previous = { HOME: process.env.HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
  try {
    process.env.HOME = home;
    delete process.env.GEMINI_CLI_HOME;
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
