/**
 * Tests for the ConnectionStatus navbar tag state machine.
 *
 * The state machine is non-trivial: it has to discriminate transient
 * reconnects (silent), stuck-too-long reconnects (escalate to red
 * "Can't reconnect"), short-gap reconnects (green flash), and long-gap
 * reconnects (yellow "Reconnected — refresh?" cue). Pinning the behavior
 * here prevents two specific regressions we already burned on:
 *
 *   1. Timer started on `connecting && !connected` — missed the 1.5s
 *      grace window in useAgorClient that keeps `connected=true` while
 *      flipping `connecting=true`, so sub-grace reconnects silently
 *      dropped the green flash.
 *   2. Successful in-place re-auth on TOKENS_REFRESHED_EVENT didn't
 *      publish to React state, leaving the navbar stuck on "Reconnecting"
 *      forever. That fix lives in useAgorClient; we cover the navbar's
 *      reaction to the state it produces.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStatus } from './ConnectionStatus';

// useConnectionState reads from React context populated by App.tsx. Mock
// the hook directly so tests don't need to wrap in a provider just to flip
// `outOfSync`. Default returns "synced" — individual tests override.
const mockConnectionState = vi.fn(() => ({
  outOfSync: false,
  capturedSha: null as string | null,
  currentSha: null as string | null,
  connected: true,
  connecting: false,
}));
vi.mock('../../contexts/ConnectionContext', () => ({
  useConnectionState: () => mockConnectionState(),
}));

describe('ConnectionStatus', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockConnectionState.mockReturnValue({
      outOfSync: false,
      capturedSha: null,
      currentSha: null,
      connected: true,
      connecting: false,
    });
    // jsdom's `window.location.reload` is non-configurable, so we replace
    // the whole `location` global via vi.stubGlobal and restore in
    // afterEach. Only `reload` is exercised; other properties are passed
    // through from the real location so anything that reads `pathname`,
    // `href`, etc. still works.
    reloadSpy = vi.fn();
    vi.stubGlobal('location', {
      ...window.location,
      reload: reloadSpy,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders nothing in steady state (connected, never disconnected)', () => {
    const { container } = render(<ConnectionStatus connected={true} connecting={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the Reconnecting tag when connecting and forwards clicks to onRetry', () => {
    const onRetry = vi.fn();
    render(<ConnectionStatus connected={false} connecting={true} onRetry={onRetry} />);
    const tag = screen.getByText('Reconnecting');
    expect(tag).toBeInTheDocument();
    fireEvent.click(tag);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('escalates to "Can\'t reconnect — reload" after STUCK_RECONNECT_MS (20s)', () => {
    render(<ConnectionStatus connected={false} connecting={true} />);
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();

    // Sub-threshold: still Reconnecting.
    act(() => {
      vi.advanceTimersByTime(19_000);
    });
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();

    // Crosses 20s threshold on the next per-second tick.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const tag = screen.getByText("Can't reconnect — reload");
    expect(tag).toBeInTheDocument();
    fireEvent.click(tag);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('shows brief green "Connected" flash after a short reconnect (< stale threshold)', () => {
    const { rerender } = render(<ConnectionStatus connected={false} connecting={true} />);
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();

    // 3s of downtime — well below STALE_THRESHOLD_MS.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    // Reconnect: connecting=false, connected=true.
    rerender(<ConnectionStatus connected={true} connecting={false} />);
    expect(screen.getByText('Connected')).toBeInTheDocument();

    // Fades after CONNECTED_FLASH_MS (3s).
    act(() => {
      vi.advanceTimersByTime(3_500);
    });
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('shows "Reconnected — refresh?" cue after a long reconnect (≥ stale threshold)', () => {
    const { rerender } = render(<ConnectionStatus connected={false} connecting={true} />);

    // 15s of downtime — crosses STALE_THRESHOLD_MS (10s).
    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    rerender(<ConnectionStatus connected={true} connecting={false} />);
    expect(screen.getByText('Reconnected — refresh?')).toBeInTheDocument();
    // Green flash should NOT show — the two cues never compete.
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();

    // Clicking the tag (anywhere except the × dismiss) reloads.
    fireEvent.click(screen.getByText('Reconnected — refresh?'));
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('dismissing the stale cue with × clears it without reloading', () => {
    const { rerender } = render(<ConnectionStatus connected={false} connecting={true} />);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    rerender(<ConnectionStatus connected={true} connecting={false} />);
    expect(screen.getByText('Reconnected — refresh?')).toBeInTheDocument();

    const dismiss = screen.getByLabelText('Dismiss');
    fireEvent.click(dismiss);

    expect(screen.queryByText('Reconnected — refresh?')).not.toBeInTheDocument();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('auto-dismisses the stale cue after STALE_AUTO_DISMISS_MS (60s)', () => {
    const { rerender } = render(<ConnectionStatus connected={false} connecting={true} />);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    rerender(<ConnectionStatus connected={true} connecting={false} />);
    expect(screen.getByText('Reconnected — refresh?')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.queryByText('Reconnected — refresh?')).not.toBeInTheDocument();
  });

  /**
   * Regression: track on `connecting`, not `connecting && !connected`.
   *
   * useAgorClient keeps `connected=true` for a 1.5s grace window after a
   * transport disconnect to suppress UI flicker. If the timer only started
   * once `connected` flipped, a reconnect that finished within that window
   * would see disconnectStartedAtRef === null on the connected→true
   * transition, and the green "Connected" flash would never appear.
   */
  it('records disconnect timestamp on raw `connecting`, even while `connected` is still true (grace window)', () => {
    // Initial: stable connected.
    const { rerender } = render(<ConnectionStatus connected={true} connecting={false} />);

    // Grace window state: connecting flips true while connected stays true.
    rerender(<ConnectionStatus connected={true} connecting={true} />);

    // 800ms passes — well inside the 1.5s grace window.
    act(() => {
      vi.advanceTimersByTime(800);
    });

    // Reconnect succeeds before the grace timer fires: connecting=false,
    // connected stayed true throughout.
    rerender(<ConnectionStatus connected={true} connecting={false} />);

    // The green flash must still appear — the bug Codex caught was that
    // it didn't, because the timer never started.
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('renders Out of sync (highest priority) when outOfSync is true, click reloads', () => {
    mockConnectionState.mockReturnValue({
      outOfSync: true,
      capturedSha: 'abc1234',
      currentSha: 'def5678',
      connected: true,
      connecting: false,
    });
    render(<ConnectionStatus connected={true} connecting={false} />);
    const tag = screen.getByText('Out of sync — refresh');
    expect(tag).toBeInTheDocument();
    fireEvent.click(tag);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('renders Disconnected when neither connected nor connecting, click calls onRetry', () => {
    const onRetry = vi.fn();
    render(<ConnectionStatus connected={false} connecting={false} onRetry={onRetry} />);
    const tag = screen.getByText('Disconnected');
    expect(tag).toBeInTheDocument();
    fireEvent.click(tag);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
