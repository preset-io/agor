import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRetainTurnOverlays } from './useTaskDetailRetention';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A turn that can open the overlays a transcript turn can reach. */
function Turn({ retain }: { retain: () => (() => void) | undefined }) {
  const { ref, handlers } = useRetainTurnOverlays(retain);
  // Like an antd Modal: mounted on first open, then kept mounted but hidden.
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewer, setViewer] = useState(false);
  const [link, setLink] = useState(false);
  return (
    <div ref={ref} {...handlers} data-task-block="turn">
      <button
        type="button"
        onClick={() => {
          setSettingsMounted(true);
          setSettingsOpen(true);
        }}
      >
        Open settings
      </button>
      <button type="button" onClick={() => setViewer(true)}>
        View fullscreen
      </button>
      <button type="button" onClick={() => setLink(true)}>
        Open link
      </button>
      {link && (
        <div data-streamdown="link-safety-modal">
          <button type="button" onClick={() => setLink(false)}>
            Cancel link
          </button>
        </div>
      )}
      {settingsMounted &&
        createPortal(
          <div role="dialog" aria-modal="true" style={{ display: settingsOpen ? '' : 'none' }}>
            <button type="button" onClick={() => setSettingsOpen(false)}>
              Close settings
            </button>
          </div>,
          document.body
        )}
      {viewer &&
        createPortal(
          <div data-streamdown="table-fullscreen" role="dialog" aria-modal="true">
            <button type="button" onClick={() => setViewer(false)}>
              Exit fullscreen
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}

/** Let the hook's post-click overlay scan run. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function fixture() {
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const view = render(<Turn retain={retain} />);
  const held = () => retain.mock.calls.length - release.mock.calls.length;
  return { retain, release, view, held };
}

describe('useRetainTurnOverlays', () => {
  it('does not pin a turn for an app modal that closes by hiding, not unmounting', async () => {
    const f = fixture();
    fireEvent.click(screen.getByText('Open settings'));
    await settle();
    fireEvent.click(screen.getByText('Close settings'));
    await settle();
    const settings = screen.getByText('Close settings').parentElement!;
    expect(settings).not.toBeVisible();
    expect(settings.isConnected).toBe(true);
    expect(f.held()).toBe(0);
    f.view.unmount();
    expect(f.held()).toBe(0);
  });

  it('pins a portaled fullscreen viewer until it closes, then stops observing', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const f = fixture();
    fireEvent.click(screen.getByText('View fullscreen'));
    await settle();
    expect(f.retain).toHaveBeenCalledTimes(1);
    // Interacting inside the portal does not pin it again.
    fireEvent.focus(screen.getByText('Exit fullscreen'));
    expect(f.retain).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Exit fullscreen'));
    await waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalled();
    expect(f.held()).toBe(0);
    f.view.unmount();
    expect(f.held()).toBe(0);
  });

  it('pins the turn while its link confirmation is open', async () => {
    const f = fixture();
    fireEvent.click(screen.getByText('Open link'));
    await settle();
    expect(f.held()).toBe(1);
    fireEvent.click(screen.getByText('Cancel link'));
    await waitFor(() => expect(f.held()).toBe(0));
  });

  it('releases a viewer still open when the turn unmounts', async () => {
    const f = fixture();
    fireEvent.click(screen.getByText('View fullscreen'));
    await settle();
    expect(f.held()).toBe(1);
    f.view.unmount();
    expect(f.held()).toBe(0);
  });
});
