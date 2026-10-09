import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadsTab } from './UploadsTab';

const showError = vi.fn();

vi.mock('../../config/daemon', () => ({ getDaemonUrl: () => 'http://daemon.test:3030/' }));
vi.mock('../../utils/authHeaders', () => ({
  getAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
}));
vi.mock('../../utils/message', () => ({ useThemedMessage: () => ({ showError }) }));

function row(ref: string, displayName: string) {
  return {
    ref,
    displayName,
    mimeType: 'application/octet-stream',
    size: 1,
    provenance: 'browser',
    createdAt: '2026-01-01T12:00:00.000Z',
    expiresAt: null,
  };
}

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

  it('offers Preview only for inline-safe types', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            uploads: [
              'chart.png:image/png',
              'config.yaml:application/x-yaml',
              'page.html:text/html',
            ].map((entry, index) => {
              const [displayName, mimeType] = entry.split(':');
              return {
                ref: `upl_${index}`,
                displayName,
                mimeType,
                size: 1,
                provenance: 'browser',
                createdAt: '2026-01-01T12:00:00.000Z',
                expiresAt: null,
              };
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    render(<UploadsTab identityKey="user-a:member" operationScope={['user-a:member', 1]} />);

    expect(await screen.findByRole('button', { name: 'Preview chart.png' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview config.yaml' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview page.html' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download page.html' })).toBeInTheDocument();
  });

  it('shows a load failure in the tab with Try again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('<!doctype html>', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ uploads: [row('upl_1', 'kept.txt')] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<UploadsTab identityKey="user-a:member" operationScope={['user-a:member', 1]} />);

    expect(await screen.findByText("Couldn't load uploads.")).toBeInTheDocument();
    expect(showError).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('HTTP 502')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('kept.txt')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load uploads.")).not.toBeInTheDocument();
  });

  it('names a deleted or inaccessible upload plainly when delete gets a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ uploads: [row('upl_1', 'gone.txt')] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ name: 'NotFound', message: 'Upload unavailable', code: 404 }),
            {
              status: 404,
            }
          )
        )
    );

    render(<UploadsTab identityKey="user-a:member" operationScope={['user-a:member', 1]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete gone.txt' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith(
        "Couldn't delete the upload. It may have been deleted, or you may not have access."
      )
    );
  });

  it('keeps the HTTP status when opening an upload fails without a plain reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ uploads: [row('upl_1', 'file.bin')] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(new Response('', { status: 500 }))
    );

    render(<UploadsTab identityKey="user-a:member" operationScope={['user-a:member', 1]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download file.bin' }));

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith("Couldn't open the upload. (HTTP 500)")
    );
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
