import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  backgroundReadsClear,
  FOREGROUND_HOLD_TIMEOUT_MS,
  holdBackgroundReads,
} from './backgroundReads';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  // Let every hold of the test expire.
  await vi.advanceTimersByTimeAsync(10 * FOREGROUND_HOLD_TIMEOUT_MS);
  vi.useRealTimers();
});

it('a background read waits for foreground holds, at most one bound from when it began', async () => {
  let clear = false;
  holdBackgroundReads(new Promise(() => {}));
  void backgroundReadsClear().then(() => {
    clear = true;
  });
  // Overlapping holds keep arriving, each before the previous one expires.
  for (let elapsed = 0; elapsed < FOREGROUND_HOLD_TIMEOUT_MS; elapsed += 2_000) {
    await vi.advanceTimersByTimeAsync(2_000);
    holdBackgroundReads(new Promise(() => {}));
    if (elapsed + 2_000 < FOREGROUND_HOLD_TIMEOUT_MS) expect(clear).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(clear).toBe(true);
});

it('a background read goes as soon as the foreground reads settle', async () => {
  let settle: () => void = () => {};
  holdBackgroundReads(new Promise<void>((resolve) => (settle = resolve)));
  let clear = false;
  void backgroundReadsClear().then(() => {
    clear = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(clear).toBe(false);
  settle();
  await vi.advanceTimersByTimeAsync(0);
  expect(clear).toBe(true);
});
