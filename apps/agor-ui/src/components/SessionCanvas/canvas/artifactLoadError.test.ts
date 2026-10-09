import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeArtifactLoadFailure, fetchArtifactPayload } from './artifactLoadError';

afterEach(() => vi.unstubAllGlobals());

describe('fetchArtifactPayload', () => {
  it.each([
    {
      shape: 'Feathers JSON body',
      response: () =>
        new Response(JSON.stringify({ message: 'Artifact a1 not found', code: 500 }), {
          status: 500,
        }),
      failure: { status: 500, message: 'Artifact a1 not found' },
    },
    {
      shape: 'non-JSON body with blank statusText',
      response: () => new Response('<html>bad gateway</html>', { status: 502 }),
      failure: { status: 502, message: 'HTTP 502' },
    },
  ])('reads the failure from a $shape', async ({ response, failure }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response())
    );
    expect(await fetchArtifactPayload('a1')).toEqual({ failure });
  });

  it('reports a network error without a status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    expect(await fetchArtifactPayload('a1')).toEqual({ failure: { message: 'Failed to fetch' } });
  });

  it('returns the payload on success', async () => {
    const payload = { artifact_id: 'a1', content_hash: 'h1' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload)))
    );
    expect(await fetchArtifactPayload('a1')).toEqual({ payload });
  });
});

describe('describeArtifactLoadFailure', () => {
  it.each([
    { status: 403, message: "You don't have access to this artifact.", canRetry: false },
    { status: 404, message: 'This artifact no longer exists.', canRetry: false },
    { status: 500, message: "Couldn't load this artifact.", canRetry: true },
    { status: undefined, message: "Couldn't load this artifact.", canRetry: true },
  ])('$status: $message', ({ status, message, canRetry }) => {
    const notice = describeArtifactLoadFailure({ status, message: 'raw error' });
    expect(notice).toMatchObject({ message, canRetry });
    expect(notice.details).toEqual([
      ...(status ? [{ label: 'Status', value: String(status), code: true }] : []),
      { label: 'Error', value: 'raw error', code: true },
    ]);
  });
});
