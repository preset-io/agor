import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingProviderHttpError, OpenAIEmbeddingProvider, parseRetryAfter } from './embeddings';

describe('OpenAIEmbeddingProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes cancellation through to the cost-bearing provider request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBeDefined();
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [0.25] }], model: 'test-model' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(
      new OpenAIEmbeddingProvider().embed(
        [{ id: 'unit-1', text: 'hello', inputType: 'document' }],
        { apiKey: 'secret', model: 'test-model', dimensions: 1, signal: controller.signal }
      )
    ).resolves.toMatchObject([{ id: 'unit-1', embedding: [0.25] }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 400, retryable: false },
    { status: 401, retryable: false },
    { status: 403, retryable: false },
    { status: 429, retryable: true },
    { status: 503, retryable: true },
  ])('preserves HTTP $status and retryability', async ({ status, retryable }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response('provider failure', {
            status,
            headers: status === 429 ? { 'retry-after': '17' } : undefined,
          })
        )
      )
    );

    const error = await new OpenAIEmbeddingProvider()
      .embed([{ id: 'unit-1', text: 'hello', inputType: 'document' }], {
        apiKey: 'secret',
        model: 'test-model',
        dimensions: 1,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmbeddingProviderHttpError);
    expect(error).toMatchObject({ status, retryable });
    expect((error as EmbeddingProviderHttpError).retryAfterMs).toBe(status === 429 ? 17_000 : null);
    expect((error as EmbeddingProviderHttpError).retryAfterAt).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('keeps delta seconds relative but preserves HTTP dates as absolute instants', () => {
    expect(parseRetryAfter('2.5')).toEqual({ delayMs: 2_500, at: null });
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:05 GMT')).toEqual({
      delayMs: null,
      at: new Date('1970-01-01T00:00:05.000Z'),
    });
    expect(parseRetryAfter('invalid')).toEqual({ delayMs: null, at: null });
  });
});
