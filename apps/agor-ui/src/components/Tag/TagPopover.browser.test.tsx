import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { Tag } from './Tag';
import { TagPopover } from './TagPopover';

afterEach(cleanup);

/**
 * Real layout only: whether a popup fits above its chip, and where AntD moves
 * it when it does not, needs true element boxes that jsdom does not compute.
 */
const ClippedPanel: React.FC<{ edge: 'top' | 'bottom'; children: React.ReactNode }> = ({
  edge,
  children,
}) => (
  <div
    data-testid="panel"
    style={{
      position: 'fixed',
      [edge]: 0,
      left: 0,
      width: 300,
      height: 100,
      overflow: 'hidden',
    }}
  >
    {children}
  </div>
);

const POPUP_HEIGHT = 240;

const chipPopover = (
  <TagPopover
    trigger="click"
    content={<div style={{ width: 240, height: POPUP_HEIGHT }}>Popup body</div>}
  >
    <Tag>MCP</Tag>
  </TagPopover>
);

it('flips a chip popup that has no room above the chip', async () => {
  render(<ClippedPanel edge="top">{chipPopover}</ClippedPanel>);

  await userEvent.click(screen.getByText('MCP'));

  const popup = await screen.findByText('Popup body');
  const chipTop = screen.getByText('MCP').getBoundingClientRect().top;
  // Poll: AntD parks the popup off-screen until its open motion has aligned it.
  await expect.poll(() => popup.getBoundingClientRect().top).toBeGreaterThan(chipTop);
});

it('escapes the clipped panel instead of being cut off by it', async () => {
  render(<ClippedPanel edge="bottom">{chipPopover}</ClippedPanel>);

  await userEvent.click(screen.getByText('MCP'));

  const popup = await screen.findByText('Popup body');
  const panel = screen.getByTestId('panel').getBoundingClientRect();
  // AntD parks the popup off-screen and zooms it in, so wait for the settled
  // box before measuring: on screen, and reaching above the panel's top edge.
  await expect
    .poll(() => {
      const box = popup.getBoundingClientRect();
      return box.top >= 0 && box.top < panel.top;
    })
    .toBe(true);
  expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
});
