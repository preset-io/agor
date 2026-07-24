import { createHash } from 'node:crypto';
import {
  DEFAULT_KNOWLEDGE_SEMANTIC_POLICY,
  KNOWLEDGE_OPENAI_EMBEDDING_MODELS,
} from '@agor/core/types';

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

export const DEFAULT_OPENAI_EMBEDDING_MODEL = DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.model;
export const DEFAULT_OPENAI_EMBEDDING_DIMENSIONS = DEFAULT_KNOWLEDGE_SEMANTIC_POLICY.dimensions;
export const SUPPORTED_OPENAI_EMBEDDING_MODELS = new Set<string>(KNOWLEDGE_OPENAI_EMBEDDING_MODELS);

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
