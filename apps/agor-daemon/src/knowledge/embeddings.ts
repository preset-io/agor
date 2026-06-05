import { createHash } from 'node:crypto';

export interface EmbeddingInput {
  id: string;
  text: string;
  inputType: 'document' | 'query';
}

export interface EmbeddingResult {
  id: string;
  embedding: number[];
  model: string;
  dimensions: number;
  tokenCount?: number;
}

export interface EmbeddingOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
}

export interface EmbeddingProvider {
  id: 'openai';
  embed(inputs: EmbeddingInput[], options: EmbeddingOptions): Promise<EmbeddingResult[]>;
}

export const KNOWLEDGE_EMBEDDINGS_NAMESPACE = 'knowledge.embeddings';
export const KNOWLEDGE_EMBEDDINGS_API_KEY = 'api_key';
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_OPENAI_EMBEDDING_DIMENSIONS = 1536;
export const SUPPORTED_OPENAI_EMBEDDING_MODELS = new Set([
  'text-embedding-3-small',
  'text-embedding-3-large',
]);

export const DEFAULT_KNOWLEDGE_CHUNKING = {
  target_tokens: 850,
  max_tokens: 1200,
  overlap_tokens: 100,
  min_tokens: 80,
};

export const DEFAULT_KNOWLEDGE_INDEXING = {
  paused: false,
  batch_size: 32,
  concurrency: 1,
};

export function normalizeKnowledgeEmbeddingApiKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export function isUsableOpenAIEmbeddingConfig(
  semantic: {
    enabled?: boolean;
    provider?: string | null;
    model?: string | null;
    dimensions?: number | null;
  },
  hasApiKey: boolean
): boolean {
  const model = semantic.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
  const dimensions = semantic.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS;
  return (
    semantic.enabled === true &&
    (semantic.provider ?? 'openai') === 'openai' &&
    SUPPORTED_OPENAI_EMBEDDING_MODELS.has(model) &&
    dimensions === DEFAULT_OPENAI_EMBEDDING_DIMENSIONS &&
    hasApiKey
  );
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  id = 'openai' as const;

  async embed(inputs: EmbeddingInput[], options: EmbeddingOptions): Promise<EmbeddingResult[]> {
    if (inputs.length === 0) return [];
    const response = await fetch(`${options.baseUrl ?? 'https://api.openai.com/v1'}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        input: inputs.map((input) => input.text),
        dimensions: options.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `OpenAI embeddings request failed (${response.status}): ${body.slice(0, 500)}`
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
      model?: string;
      usage?: { total_tokens?: number };
    };
    const byIndex = new Map((payload.data ?? []).map((item) => [item.index, item.embedding]));
    const perInputTokens = payload.usage?.total_tokens
      ? Math.ceil(payload.usage.total_tokens / inputs.length)
      : undefined;
    return inputs.map((input, index) => {
      const embedding = byIndex.get(index);
      if (!embedding) throw new Error(`OpenAI embeddings response missing index ${index}`);
      return {
        id: input.id,
        embedding,
        model: payload.model ?? options.model,
        dimensions: embedding.length,
        tokenCount: perInputTokens,
      };
    });
  }
}

export function embeddingToPgvector(value: number[]): string {
  return `[${value.join(',')}]`;
}
