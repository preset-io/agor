import { cleanup, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { useFlippingPopupPosition } from './flippingPopup';

afterEach(cleanup);

const POPUP_SIZE = 240;
const GAP = 8;

/**
 * The shape `SessionMcpFooterControl` uses: a chip in clipped chrome opening a
 * portaled `dialog`. Real layout only — whether the popup fits above its chip
 * needs true element boxes that jsdom does not compute.
 */
const Disclosure: React.FC<{ edge: 'top' | 'bottom' }> = ({ edge }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const position = useFlippingPopupPosition(open, triggerRef, popupRef, GAP);

  return (
    <div
      data-testid="panel"
      style={{ position: 'fixed', [edge]: 0, left: 0, width: 300, height: 100, overflow: 'hidden' }}
    >
      <button ref={triggerRef} type="button" onClick={() => setOpen((prev) => !prev)}>
        MCP
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            role="dialog"
            aria-label="Disclosure"
            style={{
              position: 'fixed',
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? undefined : 'hidden',
              width: POPUP_SIZE,
              height: POPUP_SIZE,
            }}
          >
            Popup body
          </div>,
          document.body
        )}
    </div>
  );
};

it('flips the disclosure below a chip with no room above it', async () => {
  render(<Disclosure edge="top" />);

  await userEvent.click(screen.getByRole('button', { name: 'MCP' }));

  const popup = screen.getByRole('dialog', { name: 'Disclosure' }).getBoundingClientRect();
  const chip = screen.getByRole('button', { name: 'MCP' }).getBoundingClientRect();
  expect(popup.top).toBeGreaterThanOrEqual(chip.bottom);
  expect(popup.bottom).toBeLessThanOrEqual(window.innerHeight);
});

it('escapes the clipped panel instead of being cut off by it', async () => {
  render(<Disclosure edge="bottom" />);

  await userEvent.click(screen.getByRole('button', { name: 'MCP' }));

  const popup = screen.getByRole('dialog', { name: 'Disclosure' }).getBoundingClientRect();
  const panel = screen.getByTestId('panel').getBoundingClientRect();
  // Reaching above the panel's top edge is what "not clipped by the panel"
  // means; the rest is what "not clipped by the viewport" means.
  expect(popup.top).toBeLessThan(panel.top);
  expect(popup.top).toBeGreaterThanOrEqual(0);
  expect(popup.bottom).toBeLessThanOrEqual(window.innerHeight);
});
