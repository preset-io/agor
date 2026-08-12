import {
  type AgenticToolName,
  classifyProviderError,
  type Message,
  PROVIDER_CREDIT_EXHAUSTED_MESSAGE,
} from '@agor/core/types';

export interface SafeProviderFailureMessage {
  content: string;
  metadata?: Message['metadata'];
}

/**
 * Convert a provider failure into durable user-facing state. Recognized quota
 * failures deliberately discard the raw provider body and retain only stable
 * classification metadata.
 */
export function buildSafeProviderFailureMessage(
  failure: unknown,
  fallbackContent: string,
  tool: AgenticToolName
): SafeProviderFailureMessage {
  const classification = classifyProviderError(failure);
  if (!classification) return { content: fallbackContent };

  return {
    content: PROVIDER_CREDIT_EXHAUSTED_MESSAGE,
    metadata: {
      error_kind: classification.kind,
      error_code: classification.code,
      tool,
    },
  };
}
