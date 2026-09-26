import { describe, expect, it } from 'vitest';
import { GeminiIntegrationError, geminiError, geminiSessionId } from './runtime.js';

describe('fixed Gemini errors', () => {
  it.each([
    [
      { status: 400, message: 'API_KEY_INVALID SECRET' },
      'Gemini rejected the API key. Check it in Settings → Gemini.',
    ],
    [
      { status: 401, message: 'SECRET' },
      'Gemini rejected the API key. Check it in Settings → Gemini.',
    ],
    [{ status: 403 }, 'Gemini rejected the API key. Check it in Settings → Gemini.'],
    [{ status: 404 }, "Model test isn't available to this API key. Pick another Gemini model."],
    [
      { name: 'TerminalQuotaError', status: 429 },
      "This API key's plan or quota doesn't allow this request.",
    ],
    [
      { status: 429, message: 'RetryInfo SECRET' },
      'Gemini is busy or rate-limited. Try again shortly.',
    ],
    [{ status: 503 }, 'Gemini is busy or rate-limited. Try again shortly.'],
    [{ status: 500 }, 'Gemini API error. Try again later.'],
    [{ message: 'fetch failed SECRET' }, 'Could not reach the Gemini API.'],
    [{ message: 'SECRET' }, 'Gemini integration error.'],
  ])('maps without reflecting provider text', (error, expected) => {
    expect(geminiError({ error }, 'test').message).toBe(expected);
    expect(geminiError(error, 'test').message).not.toContain('SECRET');
  });
  it('preserves only integration-owned errors', () => {
    const error = new GeminiIntegrationError('fixed error');
    expect(geminiError(error, 'test')).toBe(error);
  });
  it('does not share SDK filename prefixes for same-minute sessions', () => {
    const a = geminiSessionId('019f0000-1234-7000-8000-000000000001');
    const b = geminiSessionId('019f0000-1234-7000-8000-000000000002');
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8));
    expect(geminiSessionId('same')).toBe(geminiSessionId('same'));
  });
});
