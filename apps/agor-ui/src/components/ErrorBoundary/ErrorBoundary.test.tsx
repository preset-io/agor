import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

// A child that throws on demand, so we can drive the boundary from "crashed"
// back to "healthy" the way the "Reload canvas" action does.
function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('canvas render loop');
  }
  return <div>canvas content</div>;
}

describe('ErrorBoundary canvas variant', () => {
  beforeEach(() => {
    // React logs caught render errors to console.error; silence the expected
    // noise so a green run stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the surrounding shell alive and shows a recoverable fallback', () => {
    render(
      <div>
        <div>app shell</div>
        <ErrorBoundary variant="canvas">
          <Bomb shouldThrow />
        </ErrorBoundary>
      </div>
    );

    // Shell outside the boundary survives the canvas crash.
    expect(screen.getByText('app shell')).toBeInTheDocument();
    expect(screen.getByText('The canvas stopped rendering.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload canvas/i })).toBeInTheDocument();
    // The crashed subtree is not rendered.
    expect(screen.queryByText('canvas content')).not.toBeInTheDocument();
  });

  it('recovers in place when "Reload canvas" is clicked after the error clears', () => {
    let live = true;
    function LiveBomb() {
      if (live) throw new Error('canvas render loop');
      return <div>canvas content</div>;
    }

    render(
      <ErrorBoundary variant="canvas">
        <LiveBomb />
      </ErrorBoundary>
    );

    expect(screen.getByText('The canvas stopped rendering.')).toBeInTheDocument();

    // Simulate the underlying condition clearing (tab settled, dimensions
    // stable) before the user retries; the reset re-mounts the now-healthy
    // subtree in place, no page reload.
    live = false;
    fireEvent.click(screen.getByRole('button', { name: /reload canvas/i }));

    expect(screen.getByText('canvas content')).toBeInTheDocument();
    expect(screen.queryByText('The canvas stopped rendering.')).not.toBeInTheDocument();
  });
});
