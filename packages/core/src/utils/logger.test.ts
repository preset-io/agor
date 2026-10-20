import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnvironment = { ...process.env };

describe('patchConsole', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.JOURNAL_STREAM;
    delete process.env.AGOR_LOG_FORMAT;
    process.env.LOG_LEVEL = 'debug';
  });

  afterEach(async () => {
    const { unpatchConsole } = await import('./logger.js');
    unpatchConsole();
    vi.restoreAllMocks();
    process.env = { ...originalEnvironment };
  });

  it('preserves unprefixed console arguments outside systemd', async () => {
    const originalError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    const error = new Error('failure');
    console.error('message', error);
    expect(originalError).toHaveBeenCalledWith('message', error);
  });

  it('retains the original console methods for unpatching', async () => {
    const originalError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { patchConsole, unpatchConsole } = await import('./logger.js');
    patchConsole();

    expect(
      (console as Console & { __originalMethods?: { error: typeof console.error } })
        .__originalMethods?.error
    ).toBe(originalError);

    unpatchConsole();
    expect(console.error).toBe(originalError);
  });

  it('adds the corresponding journal priority to each level under systemd', async () => {
    process.env.JOURNAL_STREAM = '9:12345';
    const methods = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    console.debug('debug');
    console.log('log');
    console.info('info');
    console.warn('warn');
    console.error('error');
    expect(methods.debug).toHaveBeenCalledWith('<7>debug');
    expect(methods.log).toHaveBeenCalledWith('<6>log');
    expect(methods.info).toHaveBeenCalledWith('<6>info');
    expect(methods.warn).toHaveBeenCalledWith('<4>warn');
    expect(methods.error).toHaveBeenCalledWith('<3>error');
  });

  it('prefixes every line after formatting multiple arguments', async () => {
    process.env.JOURNAL_STREAM = '9:12345';
    const originalError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    const error = new Error('failure');
    error.stack = 'Error: failure\n    at worker.ts:10:2';
    console.error('request failed', error);
    expect(originalError).toHaveBeenCalledWith(
      '<3>request failed Error: failure\n<3>    at worker.ts:10:2'
    );
  });

  it('still filters messages below LOG_LEVEL', async () => {
    process.env.JOURNAL_STREAM = '9:12345';
    process.env.LOG_LEVEL = 'warn';
    vi.resetModules();
    const originalLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    console.log('hidden');
    console.warn('visible');
    expect(originalLog).not.toHaveBeenCalled();
    expect(originalWarn).toHaveBeenCalledWith('<4>visible');
  });
});

describe('patchConsole text mode', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.JOURNAL_STREAM;
    delete process.env.AGOR_LOG_FORMAT;
    process.env.LOG_LEVEL = 'debug';
  });

  afterEach(async () => {
    const { unpatchConsole } = await import('./logger.js');
    unpatchConsole();
    vi.restoreAllMocks();
    process.env = { ...originalEnvironment };
  });

  it('text mode output is unchanged', async () => {
    const error = new Error('failure');
    error.stack = 'Error: failure\n    at worker.ts:10:2';
    const args = ['request failed', { x: 1 }, error] as const;

    const plain = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { patchConsole, unpatchConsole } = await import('./logger.js');
    patchConsole();
    console.error(...args);
    expect(plain).toHaveBeenCalledTimes(1);
    expect(plain.mock.calls[0]).toEqual([...args]);
    expect(plain.mock.calls[0][2]).toBe(error);
    unpatchConsole();
    vi.restoreAllMocks();

    process.env.JOURNAL_STREAM = '9:12345';
    vi.resetModules();
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = await import('./logger.js');
    logger.patchConsole();
    console.error(...args);
    expect(journal).toHaveBeenCalledTimes(1);
    expect(journal.mock.calls[0]).toEqual([
      '<3>request failed { x: 1 } Error: failure\n<3>    at worker.ts:10:2',
    ]);
  });

  it('does not add a warning listener in text mode', async () => {
    const before = process.listenerCount('warning');
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    expect(process.listenerCount('warning')).toBe(before);
  });
});

describe('patchConsole json mode', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.JOURNAL_STREAM;
    process.env.AGOR_LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'debug';
  });

  afterEach(async () => {
    const { unpatchConsole } = await import('./logger.js');
    unpatchConsole();
    vi.restoreAllMocks();
    process.env = { ...originalEnvironment };
  });

  function spyStreams() {
    return {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  }

  function lines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return spy.mock.calls.map((call) => {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe('string');
      expect(call[0] as string).not.toContain('\n');
      return JSON.parse(call[0] as string) as Record<string, unknown>;
    });
  }

  it('json mode emits one line per call', async () => {
    const streams = spyStreams();
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    console.error('a\nb', { x: 1 }, new Error('boom'));
    expect(streams.error).not.toHaveBeenCalled();
    expect(streams.warn).not.toHaveBeenCalled();
    const [line, ...rest] = lines(streams.log);
    expect(rest).toEqual([]);
    expect(line.status).toBe('error');
    expect(line.message).toContain('a\nb');
    expect(line.message).toContain('boom');
    expect(Date.parse(line.timestamp as string)).not.toBeNaN();
  });

  it('json mode maps methods to status', async () => {
    const streams = spyStreams();
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    console.debug('d');
    console.log('l');
    console.info('i');
    console.warn('w');
    console.error('e');
    const emitted = lines(streams.log);
    expect(emitted.map((line) => line.status)).toEqual(['debug', 'info', 'info', 'warn', 'error']);
    for (const line of emitted) {
      for (const key of ['level', 'service', 'env', 'version', 'component', 'host', 'source']) {
        expect(line).not.toHaveProperty(key);
      }
    }
  });

  it('json mode merges log context', async () => {
    const streams = spyStreams();
    const { patchConsole } = await import('./logger.js');
    const { runWithLogContext, setLogContextField } = await import('./log-context.js');
    const { runWithTenantContext } = await import('../db/tenant-context.js');
    patchConsole();
    runWithTenantContext('tenant-a', () =>
      runWithLogContext({ session_id: 'session-1', task_id: 'task-1' }, () => {
        setLogContextField('user_id', 'user-1');
        console.info('inside');
      })
    );
    const [line] = lines(streams.log);
    expect(line).toMatchObject({
      message: 'inside',
      tenant_id: 'tenant-a',
      user_id: 'user-1',
      session_id: 'session-1',
      task_id: 'task-1',
    });
  });

  it('json mode truncates at 16 KiB', async () => {
    const streams = spyStreams();
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    console.info('x'.repeat(20_000));
    console.info('short');
    const [long, short] = lines(streams.log);
    expect(long.message).toBe('x'.repeat(16 * 1024));
    expect(long.message_truncated).toBe(true);
    expect(short).not.toHaveProperty('message_truncated');
  });

  it('level filter still applies', async () => {
    process.env.LOG_LEVEL = 'warn';
    vi.resetModules();
    const streams = spyStreams();
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    console.info('hidden');
    console.warn('visible');
    expect(lines(streams.log).map((line) => line.message)).toEqual(['visible']);
  });

  it('ignores the journald prefix', async () => {
    process.env.JOURNAL_STREAM = '9:12345';
    const streams = spyStreams();
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    console.warn('plain');
    expect(lines(streams.log)[0].message).toBe('plain');
  });

  it('warning listener logs name and code only', async () => {
    const streams = spyStreams();
    const { patchConsole } = await import('./logger.js');
    patchConsole();
    await new Promise<void>((resolve) => {
      process.once('warning', () => resolve());
      process.emitWarning('secret text', { code: 'X1' });
    });
    const emitted = lines(streams.log);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      status: 'warn',
      message: '[process.warning] name=Warning code=X1',
    });
    expect(JSON.stringify(streams.log.mock.calls)).not.toContain('secret text');
  });

  it('warning listener preserves existing listeners', async () => {
    spyStreams();
    const existing = vi.fn();
    process.on('warning', existing);
    try {
      const { patchConsole } = await import('./logger.js');
      patchConsole();
      expect(process.listeners('warning')).toContain(existing);
      await new Promise<void>((resolve) => {
        process.once('warning', () => resolve());
        process.emitWarning('w', { code: 'X2' });
      });
      expect(existing).toHaveBeenCalledTimes(1);
    } finally {
      process.off('warning', existing);
    }
  });

  it('writeLogLine bypasses patched console', async () => {
    const streams = spyStreams();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { patchConsole, writeLogLine } = await import('./logger.js');
    patchConsole();
    console.error = () => {};
    writeLogLine('error', '[area.op] stage=x');
    for (const spy of Object.values(streams)) expect(spy).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(1);
    const text = stdout.mock.calls[0][0] as string;
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ status: 'error', message: '[area.op] stage=x' });
  });
});

describe('writeLogLine text mode', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.JOURNAL_STREAM;
    delete process.env.AGOR_LOG_FORMAT;
    process.env.LOG_LEVEL = 'debug';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnvironment };
  });

  it('keeps warn and error on stderr', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { writeLogLine } = await import('./logger.js');
    writeLogLine('error', '[area.op] stage=x');
    writeLogLine('info', '[area.op] stage=y');
    expect(stderr).toHaveBeenCalledWith('[area.op] stage=x\n');
    expect(stdout).toHaveBeenCalledWith('[area.op] stage=y\n');
  });
});
