import { act, render, screen, waitFor } from '@testing-library/react';
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
      new Response(
        JSON.stringify({
          uploads: [
            {
              ref: 'upl_older',
              displayName: 'older.txt',
              mimeType: 'text/plain',
              size: 1,
              provenance: 'browser',
              createdAt: '2026-01-01T12:00:00.000Z',
              expiresAt: null,
            },
            {
              ref: 'upl_newer',
              displayName: 'newer.png',
              mimeType: 'image/png',
              size: 2,
              provenance: 'browser',
              createdAt: '2026-02-01T12:00:00.000Z',
              expiresAt: '2026-03-01T12:00:00.000Z',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadsTab identityKey="user-a:member" operationScope={['user-a:member', 1]} />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('http://daemon.test:3030/uploads', {
        headers: { Authorization: 'Bearer test-token' },
      })
    );
    expect(showError).not.toHaveBeenCalled();
    expect(screen.getByRole('columnheader', { name: 'Uploaded' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Expires' })).not.toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('newer.png');
    expect(rows[2]).toHaveTextContent('older.txt');
  });

  it('reports response parsing failures through the themed message component', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 200 }))
    );

    render(<UploadsTab identityKey="user-a:member" operationScope={['user-a:member', 1]} />);

    await waitFor(() => expect(showError).toHaveBeenCalledOnce());
    expect(showError.mock.calls[0]?.[0]).toMatch(/Unexpected token|JSON/);
  });

  it('discards an older generation response while allowing the reauthenticated reload', async () => {
    let resolve!: (response: Response) => void;
    const oldResponse = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ uploads: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const view = (generation: number) => (
      <UploadsTab identityKey="user-a:member" operationScope={['user-a:member', generation]} />
    );
    const rendered = render(view(1));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rendered.rerender(view(2));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolve(
        new Response(
          JSON.stringify({
            uploads: [
              {
                ref: 'old-private-ref',
                displayName: 'old-private-file.txt',
                mimeType: 'text/plain',
                size: 4,
                provenance: 'browser',
                createdAt: '2026-08-20T00:00:00.000Z',
                expiresAt: null,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await oldResponse;
    });
    expect(screen.queryByText('old-private-file.txt')).not.toBeInTheDocument();
    expect(showError).not.toHaveBeenCalled();
  });
});
