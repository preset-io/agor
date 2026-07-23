import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard, legacyCopy } from './clipboard';

function setSecureContext(value: boolean | undefined) {
  Object.defineProperty(globalThis, 'isSecureContext', {
    value,
    configurable: true,
  });
}

function setClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

function setExecCommand(value: boolean) {
  const execCommand = vi.fn().mockReturnValue(value);
  Object.defineProperty(document, 'execCommand', {
    value: execCommand,
    configurable: true,
  });
  return execCommand;
}

describe('copyToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setSecureContext(undefined);
  });

  it('uses navigator.clipboard in secure contexts', async () => {
    setSecureContext(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const execCommand = setExecCommand(true);

    await expect(copyToClipboard('secret')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('secret');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('skips the async API in insecure HTTP contexts to preserve user activation', async () => {
    setSecureContext(false);
    const writeText = vi.fn().mockRejectedValue(new Error('not allowed'));
    setClipboard(writeText);
    const execCommand = setExecCommand(true);

    await expect(copyToClipboard('agor_sk_test')).resolves.toBe(true);

    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back to the legacy path when navigator.clipboard rejects', async () => {
    setSecureContext(true);
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboard(writeText);
    const execCommand = setExecCommand(true);

    await expect(copyToClipboard('fallback')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('fallback');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports failure when the legacy copy path does not run', async () => {
    setSecureContext(false);
    setExecCommand(false);

    await expect(copyToClipboard('nope')).resolves.toBe(false);
  });
});

describe('legacyCopy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sets text/plain (and text/html) on the intercepted copy event', () => {
    const setData = vi.fn();
    // Emulate a browser that fires the copy event during execCommand('copy').
    const execCommand = vi.fn(() => {
      const event = new Event('copy') as unknown as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', { value: { setData }, configurable: true });
      document.dispatchEvent(event);
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    expect(legacyCopy('plain text', '<b>rich</b>')).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', 'plain text');
    expect(setData).toHaveBeenCalledWith('text/html', '<b>rich</b>');
  });

  it('returns false when execCommand throws', () => {
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => {
        throw new Error('blocked');
      }),
      configurable: true,
    });
    expect(legacyCopy('x')).toBe(false);
  });

  it('removes its temporary textarea from the DOM', () => {
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(true),
      configurable: true,
    });
    legacyCopy('cleanup');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
