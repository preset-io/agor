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
});
