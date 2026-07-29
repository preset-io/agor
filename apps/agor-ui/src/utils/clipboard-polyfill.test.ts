/**
 * Regression: on insecure origins the polyfill must provide BOTH
 * `navigator.clipboard.writeText` and `navigator.clipboard.write`.
 *
 * Streamdown copies tables via `navigator.clipboard.write([ClipboardItem])`
 * (rich text/html + text/plain). The previous polyfill only supplied
 * `writeText`, so Streamdown's `!navigator.clipboard.write` guard tripped, its
 * copy threw "Clipboard API not available" before writing anything, and the
 * table copy dropdown never closed. This locks in the `write` path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const legacyCopy = vi.fn(() => true);
vi.mock('./clipboard', () => ({ legacyCopy: (...args: unknown[]) => legacyCopy(...args) }));

import { installClipboardPolyfill } from './clipboard-polyfill';

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

function fakeClipboardItem(parts: Record<string, string>) {
  return {
    types: Object.keys(parts),
    getType: (type: string) => Promise.resolve({ text: () => Promise.resolve(parts[type]) }),
  };
}

afterEach(() => {
  legacyCopy.mockClear();
  legacyCopy.mockReturnValue(true);
  setClipboard(undefined);
});

describe('installClipboardPolyfill', () => {
  it('provides both writeText and write when the native API is absent (HTTP)', () => {
    setClipboard(undefined);
    installClipboardPolyfill();

    expect(typeof navigator.clipboard.writeText).toBe('function');
    expect(typeof navigator.clipboard.write).toBe('function');
  });

  it('copies text/plain and text/html from clipboard.write items', async () => {
    setClipboard(undefined);
    installClipboardPolyfill();

    await navigator.clipboard.write([
      fakeClipboardItem({
        'text/plain': '| a | b |',
        'text/html': '<table></table>',
      }) as unknown as ClipboardItem,
    ]);

    expect(legacyCopy).toHaveBeenCalledWith('| a | b |', '<table></table>');
  });

  it('rejects write when the legacy copy fails so callers can surface an error', async () => {
    setClipboard(undefined);
    legacyCopy.mockReturnValue(false);
    installClipboardPolyfill();

    await expect(
      navigator.clipboard.write([
        fakeClipboardItem({ 'text/plain': 'x' }) as unknown as ClipboardItem,
      ])
    ).rejects.toThrow(/copy failed/i);
  });

  it('routes writeText through the legacy copy primitive', async () => {
    setClipboard(undefined);
    installClipboardPolyfill();

    await navigator.clipboard.writeText('hello');

    expect(legacyCopy).toHaveBeenCalledWith('hello');
  });

  it('defines a ClipboardItem global when missing so `new ClipboardItem` never throws', async () => {
    setClipboard(undefined);
    // Simulate an insecure origin where the constructor is absent.
    Object.defineProperty(globalThis, 'ClipboardItem', { value: undefined, configurable: true });

    installClipboardPolyfill();

    expect(typeof (globalThis as { ClipboardItem?: unknown }).ClipboardItem).toBe('function');
    const Item = (globalThis as { ClipboardItem: new (d: unknown) => ClipboardItem }).ClipboardItem;
    const blob = new Blob(['hi'], { type: 'text/plain' });
    const item = new Item({ 'text/plain': blob });
    expect(item.types).toEqual(['text/plain']);
    // getType resolves to the stored Blob (spec surface our write() reads back).
    expect(await item.getType('text/plain')).toBe(blob);
  });

  it('leaves a complete native clipboard untouched (secure context)', () => {
    const native = { writeText: vi.fn(), write: vi.fn(), readText: vi.fn(), read: vi.fn() };
    setClipboard(native);

    installClipboardPolyfill();

    expect(navigator.clipboard).toBe(native);
  });
});
