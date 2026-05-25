import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './clipboard';

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

  it('uses execCommand first in insecure HTTP contexts to preserve user activation', async () => {
    setSecureContext(false);
    const writeText = vi.fn().mockRejectedValue(new Error('not allowed'));
    setClipboard(writeText);
    const execCommand = setExecCommand(true);

    await expect(copyToClipboard('agor_sk_test')).resolves.toBe(true);

    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when navigator.clipboard fails', async () => {
    setSecureContext(true);
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboard(writeText);
    const execCommand = setExecCommand(true);

    await expect(copyToClipboard('fallback')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('fallback');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });
});
