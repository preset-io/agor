import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTextTruncated, OverflowTooltip } from './OverflowTooltip';

function setWidths(element: HTMLElement, { client, scroll }: { client: number; scroll: number }) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: client },
    scrollWidth: { configurable: true, value: scroll },
  });
}

function renderLabel(onClick = vi.fn()) {
  render(
    <button type="button" onClick={onClick}>
      <OverflowTooltip title="A long session title that does not fit" mouseEnterDelay={0}>
        <span data-testid="label">A long session title that does not fit</span>
      </OverflowTooltip>
    </button>
  );
  return { label: screen.getByTestId('label'), onClick };
}

afterEach(() => vi.unstubAllGlobals());

describe('isTextTruncated', () => {
  it('compares scroll width against the visible width', () => {
    const element = document.createElement('span');
    setWidths(element, { client: 100, scroll: 100 });
    expect(isTextTruncated(element)).toBe(false);
    setWidths(element, { client: 100, scroll: 101 });
    expect(isTextTruncated(element)).toBe(true);
    expect(isTextTruncated(null)).toBe(false);
  });
});

describe('OverflowTooltip', () => {
  it('shows the full text on hover when the text is truncated', async () => {
    const { label } = renderLabel();
    setWidths(label, { client: 120, scroll: 480 });

    fireEvent.mouseEnter(label);

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'A long session title that does not fit'
    );
  });

  it('stays closed on hover when the text fits', async () => {
    const { label } = renderLabel();
    setWidths(label, { client: 480, scroll: 480 });

    fireEvent.mouseEnter(label);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('measures on hover rather than on render, so a later truncation still shows', async () => {
    const { label } = renderLabel();
    // Fits on first hover...
    setWidths(label, { client: 480, scroll: 480 });
    fireEvent.mouseEnter(label);
    fireEvent.mouseLeave(label);
    // ...then the container narrows and the next hover sees the ellipsis.
    setWidths(label, { client: 120, scroll: 480 });
    fireEvent.mouseEnter(label);

    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
  });

  it('closes when a resize makes the open tooltip text fit again', async () => {
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const { label } = renderLabel();
    setWidths(label, { client: 120, scroll: 480 });
    fireEvent.mouseEnter(label);
    const tooltip = await screen.findByRole('tooltip');

    setWidths(label, { client: 480, scroll: 480 });
    act(() => {
      for (const callback of callbacks) callback([], {} as ResizeObserver);
    });

    await waitFor(() => expect(tooltip.closest('.ant-tooltip')).toHaveClass('ant-tooltip-hidden'));
  });

  it('does not intercept clicks on the element it wraps', () => {
    const { label, onClick } = renderLabel();
    setWidths(label, { client: 120, scroll: 480 });

    fireEvent.click(label);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
