/**
 * Token usage data from LLM API responses
 *
 * This type represents raw token usage as returned by various LLM SDKs.
 * It uses snake_case to match API response formats.
 */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number; // Claude-specific: prompt caching reads
  cache_creation_tokens?: number; // Claude-specific: prompt caching writes
}
