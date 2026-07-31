import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadsTab } from './UploadsTab';

const showError = vi.fn();

vi.mock('../../config/daemon', () => ({ getDaemonUrl: () => 'http://daemon.test:3030/' }));
vi.mock('../../utils/authHeaders', () => ({
  getAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
}));
vi.mock('../../utils/message', () => ({ useThemedMessage: () => ({ showError }) }));

describe('UploadsTab', () => {
  beforeEach(() => {
    showError.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads uploads from the daemon rather than the UI origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ uploads: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadsTab />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('http://daemon.test:3030/uploads', {
        headers: { Authorization: 'Bearer test-token' },
      })
    );
    expect(showError).not.toHaveBeenCalled();
  });

  it('reports response parsing failures through the themed message component', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 200 }))
    );

    render(<UploadsTab />);

    await waitFor(() => expect(showError).toHaveBeenCalledOnce());
    expect(showError.mock.calls[0]?.[0]).toMatch(/Unexpected token|JSON/);
  });
});
