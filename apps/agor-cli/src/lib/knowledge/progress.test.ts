import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeProgress } from './progress';

afterEach(() => vi.useRealTimers());
describe('Knowledge progress', () => {
  it('reports discovery, fixed totals and slow-request liveness without leaving timers', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const reporter = new KnowledgeProgress({
      isTTY: false,
      write: (value: string | Uint8Array) => {
        lines.push(String(value));
        return true;
      },
    });
    reporter.report('Planning', 0);
    reporter.report('Importing', 0, 2);
    let complete!: () => void;
    const waiting = reporter.waiting(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(5000);
    complete();
    await waiting;
    reporter.report('Importing', 2, 2);
    reporter.failure('Resume with --resume --apply');
    reporter.close();
    expect(lines.join('')).toContain('0 discovered');
    expect(lines.join('')).toContain('2 / 2');
    expect(lines.join('')).toContain('elapsed 5s');
    expect(lines.join('')).not.toContain('\x1b');
    expect(vi.getTimerCount()).toBe(0);
  });
});
