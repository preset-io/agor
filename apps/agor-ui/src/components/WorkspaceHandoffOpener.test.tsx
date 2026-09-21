import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceHandoffOpener } from './WorkspaceHandoffOpener';

const openCatalog = vi.fn();
vi.mock('../contexts/MCPCatalogModalContext', () => ({
  useMCPCatalogModal: () => ({
    mounted: false,
    open: false,
    openCatalog,
    closeCatalog: vi.fn(),
    afterClose: vi.fn(),
    dismissForNavigation: vi.fn(),
  }),
}));

function LocationProbe() {
  const { search } = useLocation();
  return <div data-testid="search">{search}</div>;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <WorkspaceHandoffOpener />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe('WorkspaceHandoffOpener', () => {
  beforeEach(() => {
    openCatalog.mockClear();
  });

  it('opens the MCP catalog and strips the flag on ?open=mcp-catalog', async () => {
    renderAt('/?open=mcp-catalog');
    await waitFor(() => expect(openCatalog).toHaveBeenCalledTimes(1));
    // The consumed flag must not linger, so a refresh/Back does not re-open it.
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe(''));
  });

  it('fires the global-search open shortcut and strips the flag on ?open=search', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    renderAt('/?open=search');
    await waitFor(() =>
      expect(
        dispatch.mock.calls.some(
          ([e]) => e instanceof KeyboardEvent && e.key === 'k' && (e.ctrlKey || e.metaKey)
        )
      ).toBe(true)
    );
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe(''));
    expect(openCatalog).not.toHaveBeenCalled();
    dispatch.mockRestore();
  });

  it('is inert and preserves unrelated query params', async () => {
    renderAt('/?foo=bar');
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?foo=bar'));
    expect(openCatalog).not.toHaveBeenCalled();
  });
});
