import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENVIRONMENT_COMMAND_BUDGET } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentOutput, runBoundedEnvironmentShell } from './environment-shell';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
describe('bounded command execution (local fake commands only)', () => {
  it('bounds byte output even without newlines and preserves exit outcomes', async () => {
    const output = new EnvironmentOutput();
    const result = await runBoundedEnvironmentShell({
      command: `node -e 'process.stdout.write("x".repeat(100000)); process.exitCode=7'`,
      action: 'start',
      cwd: tmpdir(),
      deadline: Date.now() + 2000,
      cleanupMs: 25,
      output,
    });
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('code 7');
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.text())).toBeLessThanOrEqual(
      ENVIRONMENT_COMMAND_BUDGET.outputBytes
    );
  });
  it('kills TERM-resistant descendants after both timeout and successful parent exit', async () => {
    for (const parentExit of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), 'agor-command-test-'));
      directories.push(directory);
      const pidFile = join(directory, 'pid');
      const script = `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
      const command = `node -e '${script}' ${parentExit ? `& while [ ! -f "${pidFile}" ]; do sleep 0.01; done; exit 0` : ''}`;
      const result = await runBoundedEnvironmentShell({
        command,
        action: 'start',
        cwd: directory,
        deadline: Date.now() + 1000,
        cleanupMs: 40,
        output: new EnvironmentOutput(),
      });
      expect(result.outcome).toBe(parentExit ? 'succeeded' : 'unknown');
      const pid = Number(await readFile(pidFile, 'utf8'));
      // Linux may retain a reparented zombie briefly; it is no longer executing.
      await vi.waitFor(async () => {
        let state = '';
        try {
          state = await readFile(`/proc/${pid}/stat`, 'utf8');
        } catch {}
        expect(state === '' || state.split(' ')[2] === 'Z').toBe(true);
      });
    }
  });
  it('does not start an already expired command', async () => {
    expect(
      await runBoundedEnvironmentShell({
        command: 'exit 0',
        action: 'start',
        cwd: tmpdir(),
        deadline: Date.now() - 1,
        output: new EnvironmentOutput(),
      })
    ).toMatchObject({ outcome: 'unknown' });
  });
});
