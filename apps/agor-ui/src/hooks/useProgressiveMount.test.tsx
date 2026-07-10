import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProgressiveMount } from './useProgressiveMount';

function Probe({ enabled, resetKey = 'board-a' }: { enabled: boolean; resetKey?: string }) {
  const ready = useProgressiveMount({ enabled, resetKey });
  return <div>{ready ? 'ready' : 'deferred'}</div>;
}

describe('useProgressiveMount', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      setTimeout(() => callback(0), 0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forces ready when deferral is disabled after a component was queued', async () => {
    const { rerender } = render(<Probe enabled />);

    expect(screen.getByText('deferred')).toBeInTheDocument();

    rerender(<Probe enabled={false} />);

    await waitFor(() => expect(screen.getByText('ready')).toBeInTheDocument());
  });

  it('replays deferral synchronously when the reset key changes', async () => {
    const { rerender } = render(<Probe enabled resetKey="board-a" />);

    await waitFor(() => expect(screen.getByText('ready')).toBeInTheDocument());

    rerender(<Probe enabled resetKey="board-b" />);

    expect(screen.getByText('deferred')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('ready')).toBeInTheDocument());
  });
});
