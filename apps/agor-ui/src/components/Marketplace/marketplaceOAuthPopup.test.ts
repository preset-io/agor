import { afterEach, describe, expect, it, vi } from 'vitest';
import { openMarketplaceOAuthPopup } from './marketplaceOAuthPopup';

describe('Marketplace OAuth popup', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses a unique window per operation, severs opener, and retains guarded navigation', () => {
    const windows: Array<Record<string, any>> = [];
    const open = vi.spyOn(window, 'open').mockImplementation((_url, name) => {
      const popup = {
        name,
        opener: window,
        closed: false,
        close: vi.fn(),
        location: { replace: vi.fn() },
        document: { title: '', body: { textContent: '' } },
      };
      windows.push(popup);
      return popup as unknown as Window;
    });
    const first = openMarketplaceOAuthPopup()!;
    const second = openMarketplaceOAuthPopup()!;
    expect(open.mock.calls[0]?.[1]).not.toBe(open.mock.calls[1]?.[1]);
    expect(windows.every((popup) => popup.opener === null)).toBe(true);
    expect(first.navigate('https://one.example', () => true)).toBe(true);
    expect(second.navigate('https://two.example', () => false)).toBe(false);
    expect(windows[0]?.location.replace).toHaveBeenCalledWith('https://one.example');
    expect(windows[1]?.location.replace).not.toHaveBeenCalled();
    expect(windows[1]?.close).toHaveBeenCalledOnce();
  });
});
