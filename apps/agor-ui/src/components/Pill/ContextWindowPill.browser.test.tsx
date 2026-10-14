import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, Modal } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ContextWindowPill } from './Pill';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each([
  ['trigger', 'trigger'],
  ['trigger', 'content'],
  ['content', 'trigger'],
  ['content', 'content'],
])(
  'cancels a pending %s hover-open when Escape is pressed in %s',
  async (hoverTarget, focusTarget) => {
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <ContextWindowPill
          used={22}
          limit={100}
          taskMetadata={{ raw_sdk_response: { usage: { input_tokens: 22 } } }}
        />
      </ConfigProvider>
    );
    const trigger = screen.getByRole('button', { name: /Context window 22% used/ });
    fireEvent.click(trigger);
    const rawDetails = await screen.findByRole('button', { name: /Raw SDK Response/ });
    await waitFor(() => expect(rawDetails).toBeVisible());
    const focused = focusTarget === 'trigger' ? trigger : rawDetails;
    focused.focus();

    // Hold AntD's delayed hover callback pending across keyboard dismissal.
    // Advancing the clock makes the race deterministic, without a longer timeout.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.mouseEnter(hoverTarget === 'trigger' ? trigger : rawDetails);
    fireEvent.keyDown(focused, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    act(() => vi.advanceTimersByTime(1000));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();

    // A fresh pointer entry must still work; do not fix dismissal by disabling hover.
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(1000));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  }
);

it('keeps its enclosing modal open when Escape dismisses the breakdown', async () => {
  const onCancel = vi.fn();
  render(
    <Modal open title="Usage" footer={null} onCancel={onCancel}>
      <ContextWindowPill
        used={22}
        limit={100}
        taskMetadata={{ raw_sdk_response: { usage: { input_tokens: 22 } } }}
      />
    </Modal>
  );
  const trigger = screen.getByRole('button', { name: /Context window 22% used/ });
  fireEvent.click(trigger);
  const rawDetails = await screen.findByRole('button', { name: /Raw SDK Response/ });
  await waitFor(() => expect(rawDetails).toBeVisible());
  rawDetails.focus();
  await act(async () => userEvent.keyboard('{Escape}'));
  await waitFor(() => expect(rawDetails).not.toBeVisible(), { timeout: 2000 });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Usage' })).toBeVisible();
});

// Exercise a real exit animation longer than the former 400 ms sleep as well as default motion.
it.each([undefined, '0.6s'])(
  'returns focus to the percentage when Escape closes the breakdown from raw SDK details (motionDurationMid=%s)',
  async (motionDurationMid) => {
    render(
      <ConfigProvider theme={{ token: { motionDurationMid } }}>
        <ContextWindowPill
          used={22}
          limit={100}
          taskMetadata={{ raw_sdk_response: { usage: { input_tokens: 22 } } }}
        />
      </ConfigProvider>
    );
    const trigger = screen.getByRole('button', {
      name: 'Context window 22% used; show token breakdown',
    });
    trigger.focus();
    await act(async () => userEvent.keyboard('{Enter}'));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const rawDetails = await screen.findByRole('button', { name: /Raw SDK Response/ });
    await waitFor(() => expect(rawDetails).toBeVisible());
    await act(async () => userEvent.tab());
    expect(document.activeElement).toBe(rawDetails);

    await act(async () => userEvent.keyboard('{Escape}'));
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    // aria-expanded changes before AntD finishes leaving (or its 1s motion deadline fires).
    // Observe the hidden content rather than racing that animation with a fixed sleep.
    await waitFor(() => expect(rawDetails).not.toBeVisible(), { timeout: 2000 });
    expect(document.activeElement).toBe(trigger);
    await act(async () => userEvent.keyboard(' '));
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
    await waitFor(() => expect(rawDetails).toBeVisible());
    await act(async () => userEvent.keyboard('{Escape}'));
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(rawDetails).not.toBeVisible(), { timeout: 2000 });
    expect(trigger).toHaveFocus();
  }
);

it('does not reopen from a stationary hover after keyboard dismissal', async () => {
  render(
    <ContextWindowPill
      used={22}
      limit={100}
      taskMetadata={{ raw_sdk_response: { usage: { input_tokens: 22 } } }}
    />
  );
  const trigger = screen.getByRole('button', { name: /Context window 22% used/ });
  await act(async () => userEvent.hover(trigger));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
  const rawDetails = await screen.findByRole('button', { name: /Raw SDK Response/ });
  await waitFor(() => expect(rawDetails).toBeVisible());
  trigger.focus();
  await act(async () => userEvent.tab());
  expect(rawDetails).toHaveFocus();
  await act(async () => userEvent.keyboard('{Escape}'));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  await waitFor(() => expect(rawDetails).not.toBeVisible(), { timeout: 2000 });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
});

it('does not return focus on outside dismissal', async () => {
  render(
    <>
      <ContextWindowPill
        used={22}
        limit={100}
        taskMetadata={{ raw_sdk_response: { usage: { input_tokens: 22 } } }}
      />
      <button type="button">Outside</button>
    </>
  );
  const trigger = screen.getByRole('button', { name: /Context window 22% used/ });
  trigger.focus();
  await act(async () => userEvent.keyboard('{Enter}'));
  await screen.findByRole('button', { name: /Raw SDK Response/ });

  const outside = screen.getByRole('button', { name: 'Outside' });
  await act(async () => userEvent.click(outside));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  expect(document.activeElement).toBe(outside);
});
