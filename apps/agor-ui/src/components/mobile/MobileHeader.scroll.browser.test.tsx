import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { MobileHeader } from './MobileHeader';

afterEach(cleanup);

async function openSwitcher(count: number) {
  const onSelect = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <div style={{ height: '100dvh', overflow: 'auto' }} data-testid="background">
        <MobileHeader
          title="Board 0"
          boardSwitcher={{
            boards: Array.from({ length: count }, (_, i) => ({
              board_id: `${i}`,
              name: `Board ${i}`,
            })),
            currentBoardId: '0',
            onSelect,
          }}
        />
        <div style={{ height: 2000 }}>Background board content</div>
      </div>
    </ConfigProvider>
  );
  await userEvent.click(screen.getByRole('button', { name: /Switch board/ }));
  const dialog = await screen.findByRole('dialog');
  const body = dialog.querySelector<HTMLElement>('.ant-drawer-body')!;
  return { dialog, body, onSelect, background: screen.getByTestId('background') };
}

describe('board switcher real viewport scrolling', () => {
  it('keeps short lists compact and keyboard selectable', async () => {
    const { dialog, body, onSelect } = await openSwitcher(2);
    expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
    expect(dialog.getBoundingClientRect().height).toBeLessThan(window.innerHeight * 0.85);
    const option = screen.getByRole('button', { name: 'Switch to Board 1' });
    option.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('bounds long lists, supports native touch/wheel scrolling, and contains background scroll', async () => {
    const { dialog, body, onSelect, background } = await openSwitcher(60);
    expect(dialog.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(dialog.getBoundingClientRect().height).toBeLessThanOrEqual(
      window.innerHeight * 0.85 + 1
    );
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    const rect = body.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.bottom - 25;
    // Chromium trusted native input, not dispatchEvent or a scrollTop-only simulation.
    const protocol = cdp();
    await protocol.send('Input.synthesizeScrollGesture', {
      x,
      y,
      yDistance: -10000,
      speed: 100000,
      gestureSourceType: 'mouse',
    });
    await waitFor(() =>
      expect(body.scrollTop + body.clientHeight).toBeGreaterThanOrEqual(body.scrollHeight - 1)
    );
    expect(background.scrollTop).toBe(0);
    body.scrollTop = 0;
    await protocol.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await protocol.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 8; step++) {
      await protocol.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - step * 15 }],
      });
    }
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitFor(() => expect(body.scrollTop).toBeGreaterThan(0));
    expect(onSelect).not.toHaveBeenCalled();
    expect(background.scrollTop).toBe(0);
    expect(window.scrollY).toBe(0);
    body.scrollTop = body.scrollHeight;
    await page.screenshot({ path: `./.vitest/mobile-switcher-${window.innerWidth}.png` });
    await userEvent.click(screen.getByRole('button', { name: 'Switch to Board 59' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('59');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await protocol.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  });
});
