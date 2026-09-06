import { describe, expect, it } from 'vitest';
import { runShellCommand } from './environment.js';

describe.skipIf(process.platform === 'win32')('environment command process containment', () => {
  it('kills a real TERM-resistant command group before reporting its timeout', async () => {
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const startedAt = Date.now();
    let timedOutPid: number | undefined;

    try {
      await runShellCommand({
        command,
        cwd: process.cwd(),
        commandType: 'stop',
        timeoutMs: 100,
      });
      throw new Error('expected command timeout');
    } catch (error) {
      expect(error).toMatchObject({ message: expect.stringMatching(/exceeded.*deadline/i) });
      timedOutPid = (error as Error & { pid?: number }).pid;
    }

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_000);
    expect(timedOutPid).toEqual(expect.any(Number));
    expect(() => process.kill(-timedOutPid!, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' })
    );
  }, 15_000);
});
