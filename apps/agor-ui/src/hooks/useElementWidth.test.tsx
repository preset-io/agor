import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElementWidth } from './useElementWidth';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Probe({ onWidth }: { onWidth: (width: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  onWidth(useElementWidth(ref));
  return <div ref={ref} />;
}

describe('useElementWidth', () => {
  it('measures on mount, follows resizes and disconnects on unmount', () => {
    let resize: () => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      }
    );
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
    const widths: number[] = [];
    const { unmount } = render(<Probe onWidth={(width) => widths.push(width)} />);
    expect(widths.at(-1)).toBe(640);

    clientWidth.mockReturnValue(320);
    act(() => resize());
    expect(widths.at(-1)).toBe(320);

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
