import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from './embeddings';

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
});
