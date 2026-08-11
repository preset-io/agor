import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnvironment = { ...process.env };

describe('patchConsole', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.JOURNAL_STREAM;
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
