import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLLOUT_TAIL_LIMITS,
  findLatestRolloutRecord,
  type RolloutTailLimits,
} from './rollout-tail.js';
import { extractCodexContextSnapshotFromEvent } from './usage.js';

// Wrap `open` so individual tests can observe or perturb the file handle.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const MARKER = 'token_count';
const project = extractCodexContextSnapshotFromEvent;

/** The previous whole-file implementation, kept verbatim as the reference. */
async function legacyFullRead(filePath: string) {
  let contents: string;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let latest: ReturnType<typeof project>;
  for (const line of contents.split('\n')) {
    if (!line.includes(MARKER)) continue;
    try {
      latest = project(JSON.parse(line) as unknown) ?? latest;
    } catch {
      // Ignore malformed / partially-written JSONL lines.
    }
  }
  return latest;
}

function tokenCount(totalTokens: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    timestamp: '2026-10-02T00:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { total_tokens: totalTokens },
        model_context_window: 258_400,
      },
      ...extra,
    },
  });
}

function responseItem(text: string) {
  return JSON.stringify({
    timestamp: '2026-10-02T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'function_call_output', output: text },
  });
}

const tinyLimits = (chunkBytes: number): RolloutTailLimits => ({
  chunkBytes,
  maxLineBytes: DEFAULT_ROLLOUT_TAIL_LIMITS.maxLineBytes,
  maxScanBytes: DEFAULT_ROLLOUT_TAIL_LIMITS.maxScanBytes,
});

let dir: string;
let fileCounter = 0;

async function writeFixture(contents: string | Buffer): Promise<string> {
  const file = path.join(dir, `rollout-${fileCounter++}.jsonl`);
  await fs.writeFile(file, contents);
  return file;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-rollout-tail-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('findLatestRolloutRecord', () => {
  it('returns the newest usable record at the end of the file', async () => {
    const file = await writeFixture(
      [tokenCount(100), responseItem('hello'), tokenCount(200), ''].join('\n')
    );
    const result = await findLatestRolloutRecord(file, MARKER, project);
    expect(result?.totalTokens).toBe(200);
    expect(result).toEqual(await legacyFullRead(file));
  });

  it('skips newer lines that mention the marker but are not usable records', async () => {
    const file = await writeFixture(
      [
        tokenCount(100),
        responseItem('grep token_count prompt-service.ts'),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
        '{"type":"event_msg","payload":{"type":"token_count"', // malformed
        '',
      ].join('\n')
    );
    const result = await findLatestRolloutRecord(file, MARKER, project);
    expect(result?.totalTokens).toBe(100);
    expect(result).toEqual(await legacyFullRead(file));
  });

  it('handles CRLF, a partially-written final line, and multi-byte UTF-8 at every chunk boundary', async () => {
    const fixtures = [
      // CRLF line endings; CR is JSON whitespace.
      [tokenCount(1), responseItem('a'), tokenCount(2), ''].join('\r\n'),
      // Writer is mid-append: final record is truncated and must be ignored.
      `${[tokenCount(3), responseItem('b')].join('\n')}\n${tokenCount(4).slice(0, 40)}`,
      // No trailing newline on a complete final record.
      [responseItem('c'), tokenCount(5)].join('\n'),
      // Multi-byte characters (2-, 3-, and 4-byte sequences) on usable lines
      // so that some chunk size splits each of them.
      [
        tokenCount(6, { note: 'ä猫🙂'.repeat(7) }),
        responseItem('猫🙂ä'.repeat(11)),
        tokenCount(7, { note: '🙂猫ä'.repeat(5) }),
        responseItem('ü'),
      ].join('\n'),
    ];
    for (const contents of fixtures) {
      const file = await writeFixture(contents);
      const expected = await legacyFullRead(file);
      expect(expected).toBeDefined();
      for (let chunkBytes = 1; chunkBytes <= 64; chunkBytes++) {
        expect(
          await findLatestRolloutRecord(file, MARKER, project, tinyLimits(chunkBytes))
        ).toEqual(expected);
      }
      expect(await findLatestRolloutRecord(file, MARKER, project)).toEqual(expected);
    }
  });

  it('decodes a record whose multi-byte character straddles a chunk boundary', async () => {
    const note = '猫';
    const line = tokenCount(8, { note });
    const file = await writeFixture(line);
    // Split inside the 3-byte encoding of 猫.
    const noteOffset = Buffer.from(line).indexOf(Buffer.from(note));
    const chunkBytes = Buffer.byteLength(line) - noteOffset - 1;
    const result = await findLatestRolloutRecord(file, MARKER, (record) => record, {
      ...DEFAULT_ROLLOUT_TAIL_LIMITS,
      chunkBytes,
    });
    expect((result as { payload: { note: string } }).payload.note).toBe(note);
  });

  it('matches the full-read implementation on generated rollout files', async () => {
    // Small deterministic PRNG so failures are reproducible.
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];
    const texts = ['', 'plain', 'token_count mentioned', 'ä猫🙂 unicode', 'x'.repeat(300)];

    for (let fixture = 0; fixture < 40; fixture++) {
      const lines: string[] = [];
      const count = Math.floor(random() * 25);
      for (let i = 0; i < count; i++) {
        lines.push(
          pick([
            () => tokenCount(Math.floor(random() * 200_000)),
            () => responseItem(pick(texts)),
            () => tokenCount(Math.floor(random() * 200_000)).slice(0, 30),
            () => '',
            () => 'not json token_count',
            () => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
          ])()
        );
      }
      const eol = pick(['\n', '\r\n']);
      const contents = lines.join(eol) + pick(['', eol]);
      const file = await writeFixture(contents);
      const expected = await legacyFullRead(file);
      for (const chunkBytes of [1, 3, 17, 64, 4096]) {
        expect(
          await findLatestRolloutRecord(file, MARKER, project, tinyLimits(chunkBytes))
        ).toEqual(expected);
      }
    }
  });

  it('returns undefined for empty, missing, and record-less files', async () => {
    expect(await findLatestRolloutRecord(await writeFixture(''), MARKER, project)).toBeUndefined();
    expect(
      await findLatestRolloutRecord(path.join(dir, 'does-not-exist.jsonl'), MARKER, project)
    ).toBeUndefined();
    expect(
      await findLatestRolloutRecord(await writeFixture('\n\n\r\n'), MARKER, project)
    ).toBeUndefined();
    expect(
      await findLatestRolloutRecord(await writeFixture(tokenCount(9).slice(0, -5)), MARKER, project)
    ).toBeUndefined();
  });

  it('skips lines longer than maxLineBytes without buffering them', async () => {
    const limits = { chunkBytes: 1024, maxLineBytes: 4096, maxScanBytes: 1 << 20 };
    // A huge newer line that would parse as a usable record is skipped (the
    // documented bounded deviation); the older normal record is returned.
    const hugeRecord = tokenCount(999, { padding: 'p'.repeat(10_000) });
    const file = await writeFixture(
      [tokenCount(10), responseItem('x'.repeat(10_000)), hugeRecord, ''].join('\n')
    );
    expect((await findLatestRolloutRecord(file, MARKER, project, limits))?.totalTokens).toBe(10);

    // A single huge line with no newline at all.
    const single = await writeFixture(hugeRecord);
    expect(await findLatestRolloutRecord(single, MARKER, project, limits)).toBeUndefined();

    // Default limits: a 3 MiB tool output after the usage record.
    const big = await writeFixture(
      [tokenCount(11), responseItem('y'.repeat(3 * 1024 * 1024)), ''].join('\n')
    );
    expect((await findLatestRolloutRecord(big, MARKER, project))?.totalTokens).toBe(11);
  });

  it('stops after maxScanBytes and never reads the whole file', async () => {
    const actualOpen = (
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    ).open;
    let bytesRead = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{
        bytesRead: number;
      }>;
      Reflect.set(handle, 'read', async (...readArgs: unknown[]) => {
        const result = await read(...readArgs);
        bytesRead += result.bytesRead;
        return result;
      });
      return handle;
    });

    try {
      const filler = `${responseItem('f'.repeat(1000))}\n`.repeat(18 * 1024);
      const fillerBytes = Buffer.byteLength(filler);
      expect(fillerBytes).toBeGreaterThan(DEFAULT_ROLLOUT_TAIL_LIMITS.maxScanBytes);

      // Usage only far back, beyond the scan budget: unknown (full read found it).
      const farBack = await writeFixture(`${tokenCount(12)}\n${filler}`);
      expect((await legacyFullRead(farBack))?.totalTokens).toBe(12);
      bytesRead = 0;
      expect(await findLatestRolloutRecord(farBack, MARKER, project)).toBeUndefined();
      expect(bytesRead).toBe(DEFAULT_ROLLOUT_TAIL_LIMITS.maxScanBytes);

      // Usage near the end of the same-sized file: found after one chunk.
      const nearEnd = await writeFixture(`${filler}${tokenCount(13)}\n`);
      bytesRead = 0;
      expect((await findLatestRolloutRecord(nearEnd, MARKER, project))?.totalTokens).toBe(13);
      expect(bytesRead).toBe(DEFAULT_ROLLOUT_TAIL_LIMITS.chunkBytes);

      // Usage within the budget but behind many chunks of tool output.
      const withinBudget = await writeFixture(
        `${tokenCount(14)}\n${filler.slice(0, 8 * 1024 * 1024)}`
      );
      expect((await findLatestRolloutRecord(withinBudget, MARKER, project))?.totalTokens).toBe(14);
    } finally {
      vi.mocked(fs.open).mockImplementation(actualOpen);
    }
  });

  it('gives up instead of joining non-contiguous bytes when the file shrinks mid-read', async () => {
    const actualOpen = (
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    ).open;
    const file = await writeFixture(`${tokenCount(15)}\n${responseItem('z'.repeat(200))}\n`);
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      const stat = handle.stat.bind(handle);
      Reflect.set(handle, 'stat', async () => {
        const stats = await stat();
        await fs.truncate(file, 10);
        return stats;
      });
      return handle;
    });
    expect(await findLatestRolloutRecord(file, MARKER, project, tinyLimits(64))).toBeUndefined();
  });

  it('ignores bytes appended after the initial size snapshot', async () => {
    const actualOpen = (
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    ).open;
    const file = await writeFixture(`${tokenCount(16)}\n`);
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      const stat = handle.stat.bind(handle);
      Reflect.set(handle, 'stat', async () => {
        const stats = await stat();
        await fs.appendFile(file, `${tokenCount(17)}\n`);
        return stats;
      });
      return handle;
    });
    expect((await findLatestRolloutRecord(file, MARKER, project))?.totalTokens).toBe(16);
  });
});
