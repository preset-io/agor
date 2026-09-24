import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshTokensSingleFlight } from '../../utils/singleFlightRefresh';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '../../utils/tokenRefresh';
import { uploadFilesToSession } from './upload';

vi.mock('@agor-live/client', () => ({ createRestClient: vi.fn(async () => ({})) }));
vi.mock('../../utils/singleFlightRefresh', () => ({ refreshTokensSingleFlight: vi.fn() }));

function jwtFor(sub: string, expiresInMs = 10 * 60_000, tenantId = 'default'): string {
  const payload = btoa(
    JSON.stringify({ sub, tenant_id: tenantId, exp: Math.floor((Date.now() + expiresInMs) / 1000) })
  );
  return `header.${payload.replace(/=+$/, '')}.signature`;
}

function refreshResult(accessToken: string) {
  return { accessToken, user: {} as never };
}

function okUploadResponse(): Response {
  return new Response(JSON.stringify({ success: true, files: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorizedUploadResponse(): Response {
  return new Response(JSON.stringify({ error: 'Authentication required' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'x-agor-upload-request-id': 'request-401' },
  });
}

describe('uploadFilesToSession', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.mocked(refreshTokensSingleFlight).mockReset();
  });

  it('refreshes the stored token and retries once when the daemon returns 401', async () => {
    const staleToken = jwtFor('user-a');
    const freshToken = jwtFor('user-a', 15 * 60_000);
    localStorage.setItem(ACCESS_TOKEN_KEY, staleToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, 'refresh-token');
    vi.mocked(refreshTokensSingleFlight).mockResolvedValue(refreshResult(freshToken));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(unauthorizedUploadResponse())
      .mockResolvedValueOnce(okUploadResponse());

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['image'], 'shot.png')],
      })
    ).resolves.toEqual({ success: true, files: [] });

    expect(refreshTokensSingleFlight).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: `Bearer ${staleToken}` },
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: `Bearer ${freshToken}` },
    });
  });

  it('does not replay an upload after another user signs in mid-request', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, jwtFor('user-a'));
    localStorage.setItem(REFRESH_TOKEN_KEY, 'user-a-refresh-token');
    let resolveUpload!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        })
    );
    // The shared refresh now rotates whichever user localStorage holds.
    vi.mocked(refreshTokensSingleFlight).mockResolvedValue(refreshResult(jwtFor('user-b')));

    const upload = uploadFilesToSession({
      sessionId: 'session-1',
      daemonUrl: 'https://daemon.example',
      files: [new File(['image'], 'shot.png')],
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    localStorage.setItem(ACCESS_TOKEN_KEY, jwtFor('user-b'));
    localStorage.setItem(REFRESH_TOKEN_KEY, 'user-b-refresh-token');
    resolveUpload(unauthorizedUploadResponse());

    await expect(upload).rejects.toThrow('Upload failed (HTTP 401) (reference: request-401)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes an about-to-expire stored token before uploading', async () => {
    const freshToken = jwtFor('user-a', 15 * 60_000);
    localStorage.setItem(ACCESS_TOKEN_KEY, jwtFor('user-a', 5_000));
    localStorage.setItem(REFRESH_TOKEN_KEY, 'refresh-token');
    vi.mocked(refreshTokensSingleFlight).mockResolvedValue(refreshResult(freshToken));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUploadResponse());

    await uploadFilesToSession({
      sessionId: 'session-1',
      daemonUrl: 'https://daemon.example',
      files: [new File(['image'], 'shot.png')],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: `Bearer ${freshToken}` },
    });
  });

  it('surfaces the 401 reference when refresh cannot restore the session', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, jwtFor('user-a'));
    localStorage.setItem(REFRESH_TOKEN_KEY, 'dead-refresh-token');
    vi.mocked(refreshTokensSingleFlight).mockRejectedValue(new Error('refresh rejected'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorizedUploadResponse());

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['image'], 'shot.png')],
      })
    ).rejects.toThrow('Upload failed (HTTP 401) (reference: request-401)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never swaps an explicit authentication snapshot for the stored token', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'other-user-token');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'refresh-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorizedUploadResponse());

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['image'], 'shot.png')],
        accessToken: 'initiating-user-token',
      })
    ).rejects.toThrow('Upload failed (HTTP 401)');
    expect(refreshTokensSingleFlight).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the initiating authentication snapshot and abort signal', async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'next-user-token');
    const abortController = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await uploadFilesToSession({
      sessionId: 'session-1',
      daemonUrl: 'https://daemon.example',
      files: [new File(['image'], 'shot.png')],
      accessToken: 'initiating-user-token',
      signal: abortController.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://daemon.example/sessions/session-1/upload',
      expect.objectContaining({
        headers: { Authorization: 'Bearer initiating-user-token' },
        signal: abortController.signal,
      })
    );
  });

  it('surfaces a bounded structured upload reason with its support reference', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Unsupported file type',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          requestId: 'request-123',
        }),
        { status: 415, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['html'], 'page.html')],
        accessToken: 'token',
      })
    ).rejects.toThrow('Unsupported file type (reference: request-123)');
  });

  it('does not surface a non-JSON proxy response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>proxy details that must stay hidden</body></html>', {
        status: 413,
        headers: {
          'Content-Type': 'text/html',
          'x-agor-upload-request-id': 'request-456',
        },
      })
    );

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['large'], 'large.txt')],
        accessToken: 'token',
      })
    ).rejects.toThrow('Upload failed (HTTP 413) (reference: request-456)');
  });

  it('does not trust an allowlisted code without an explicit JSON media type', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'internal path that must stay hidden',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          requestId: 'request-457',
        }),
        { status: 415, headers: { 'Content-Type': '' } }
      )
    );

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['html'], 'page.html')],
        accessToken: 'token',
      })
    ).rejects.toThrow('Upload failed (HTTP 415)');
  });

  it('does not trust an allowlisted code with the wrong 4xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'internal path that must stay hidden',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          requestId: 'request-458',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['html'], 'page.html')],
        accessToken: 'token',
      })
    ).rejects.toThrow('Upload failed (HTTP 404) (reference: request-458)');
  });

  it('keeps unknown structured errors generic and ignores malformed references', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: `  ${'x'.repeat(300)}  `,
          requestId: '<not-safe>',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['bad'], 'bad.txt')],
        accessToken: 'token',
      })
    ).rejects.toThrowError(new Error('Upload failed (HTTP 400)'));
  });

  it('keeps known policy text bounded while hiding 5xx response bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'x'.repeat(300),
          code: 'UNSUPPORTED_MEDIA_TYPE',
          requestId: 'request-789',
        }),
        { status: 415, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['bad'], 'bad.html')],
        accessToken: 'token',
      })
    ).rejects.toThrow(`x${'x'.repeat(239)} (reference: request-789)`);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'sensitive proxy body', code: 'UNSUPPORTED_MEDIA_TYPE' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['bad'], 'bad.html')],
        accessToken: 'token',
      })
    ).rejects.toThrow('Upload failed (HTTP 500)');
  });

  it('preserves the logged request UUID in the displayed reference', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Unsupported file type',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          requestId: '550e8400-e29b-41d4-a716-446655440000',
        }),
        { status: 415, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      uploadFilesToSession({
        sessionId: 'session-1',
        daemonUrl: 'https://daemon.example',
        files: [new File(['html'], 'page.html')],
        accessToken: 'token',
      })
    ).rejects.toThrow('Unsupported file type (reference: 550e8400-e29b-41d4-a716-446655440000)');
  });
});
