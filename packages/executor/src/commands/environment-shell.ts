import { spawn } from 'node:child_process';
import { ENVIRONMENT_COMMAND_BUDGET as BUDGET } from '@agor/core/types';
import { assertEnvCommandAllowed } from '@agor/core/unix';

/** A bounded tail, including commands which write one enormous line. */
export class EnvironmentOutput {
  private tail = Buffer.alloc(0);
  truncated = false;
  append(chunk: Buffer) {
    this.truncated ||= this.tail.length + chunk.length > BUDGET.outputBytes;
    this.tail = Buffer.concat([this.tail, chunk.subarray(-BUDGET.outputBytes)]).subarray(
      -BUDGET.outputBytes
    );
  }
  text() {
    let text = this.tail.toString('utf8');
    while (Buffer.byteLength(text, 'utf8') > BUDGET.outputBytes) text = text.slice(1);
    return text;
  }
}

/** Kill the owned process group even when the shell exits before its descendants. */
export async function runBoundedEnvironmentShell(options: {
  command: string;
  action: 'start' | 'stop' | 'nuke' | 'logs';
  cwd: string;
  env?: Record<string, string>;
  deadline: number;
  output: EnvironmentOutput;
  cleanupMs?: number;
}): Promise<{ outcome: 'succeeded' | 'failed' | 'unknown'; message: string }> {
  assertEnvCommandAllowed(options.command, options.action);
  if (Date.now() >= options.deadline)
    return { outcome: 'unknown', message: 'Command deadline expired before execution' };
  if (process.platform === 'win32')
    throw new Error('Bounded environment process groups require a POSIX executor');
  const child = spawn(options.command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: true,
    detached: true,
    stdio: 'pipe',
  });
  child.stdin.end();
  child.stdout.on('data', (chunk) => options.output.append(chunk));
  child.stderr.on('data', (chunk) => options.output.append(chunk));
  let cleanupFailed = false;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupFailed = true;
    }
  };
  let timedOut = false;
  let interrupted = false;
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let complete: (result: { outcome: 'succeeded' | 'failed' | 'unknown'; message: string }) => void;
  let settling = false;
  const result = new Promise<{ outcome: 'succeeded' | 'failed' | 'unknown'; message: string }>(
    (resolve) => {
      complete = resolve;
    }
  );
  const settle = (code: number | null, spawnError = false) => {
    if (settling) return;
    settling = true;
    if (timer) clearTimeout(timer);
    // Success means only the foreground command exited zero. Background work
    // is never hosted: terminate remaining descendants before reporting.
    signalGroup('SIGTERM');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      signalGroup('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      complete({
        outcome:
          timedOut || interrupted || cleanupFailed
            ? 'unknown'
            : code === 0 && !spawnError
              ? 'succeeded'
              : 'failed',
        message: cleanupFailed
          ? 'Owned process-group cleanup failed; remote outcome is unknown'
          : timedOut
            ? 'Command timed out; remote outcome is unknown'
            : interrupted
              ? 'Executor interrupted; remote outcome is unknown'
              : code === 0
                ? `${options.action} command exited successfully; remote resource state is not certified`
                : `${options.action} command ${spawnError ? 'could not start' : `exited with code ${code}`}`,
      });
    };
    let groupExists = false;
    if (child.pid) {
      try {
        process.kill(-child.pid, 0);
        groupExists = true;
      } catch {}
    }
    killTimer = setTimeout(finish, options.cleanupMs ?? BUDGET.cleanupMs);
    if (!groupExists) child.once('close', finish);
  };
  const interrupt = () => {
    interrupted = true;
    settle(null);
  };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  child.once('error', () => settle(null, true));
  child.once('exit', (code) => settle(code));
  timer = setTimeout(
    () => {
      timedOut = true;
      settle(null);
    },
    Math.max(1, options.deadline - Date.now())
  );
  try {
    return await result;
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
  }
}
