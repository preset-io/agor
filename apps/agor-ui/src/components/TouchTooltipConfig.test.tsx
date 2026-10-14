import { fireEvent, render, screen } from '@testing-library/react';
import { Button, Tooltip } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOUCH_INPUT_QUERY } from '../hooks/useCanHover';
import { TouchTooltipConfig } from './TouchTooltipConfig';

function stubTouch(touch: boolean) {
  const matchMedia = window.matchMedia;
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...matchMedia(query),
    matches: touch && query === TOUCH_INPUT_QUERY,
  }));
}

function renderTooltips() {
  const onClick = vi.fn();
  render(
    <TouchTooltipConfig>
      <Tooltip title="Archive session" mouseEnterDelay={0}>
        <Button aria-label="Archive" onClick={onClick}>
          A
        </Button>
      </Tooltip>
      <Tooltip title="Always shown" open>
        <span>controlled</span>
      </Tooltip>
    </TouchTooltipConfig>
  );
  return { button: screen.getByRole('button', { name: 'Archive' }), onClick };
}

describe('TouchTooltipConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens no hover tooltip when a touch screen taps, so the first tap acts', async () => {
    stubTouch(true);
    const { button, onClick } = renderTooltips();
    fireEvent.touchStart(button);
    fireEvent.mouseEnter(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    // The controlled tooltip still opens; it rendered last, so the hover one would have too.
    await screen.findByText('Always shown');
    expect(screen.queryByText('Archive session')).toBeNull();
  });

  it('keeps hover tooltips on desktop', async () => {
    stubTouch(false);
    const { button } = renderTooltips();
    fireEvent.mouseEnter(button);
    expect(await screen.findByText('Archive session')).toBeInTheDocument();
  });
});
