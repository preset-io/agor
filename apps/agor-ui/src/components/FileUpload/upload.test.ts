import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_KEY } from '../../utils/tokenRefresh';
import { uploadFilesToSession } from './upload';

describe('uploadFilesToSession', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
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

  it('renders a short reference when the daemon returns a full request UUID', async () => {
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
    ).rejects.toThrow('Unsupported file type (reference: 550e8400e29b41d4a7164466)');
  });
});
