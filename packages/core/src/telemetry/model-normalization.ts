const KNOWN_MODEL_PATTERNS: Array<[RegExp, string]> = [
  [/claude.*opus/i, 'claude-opus'],
  [/claude.*sonnet/i, 'claude-sonnet'],
  [/claude.*haiku/i, 'claude-haiku'],
  [/gpt-5/i, 'gpt-5'],
  [/gpt-4\.1/i, 'gpt-4.1'],
  [/gpt-4o/i, 'gpt-4o'],
  [/o3/i, 'o3'],
  [/o4/i, 'o4'],
  [/gemini.*2\.5/i, 'gemini-2.5'],
  [/gemini.*2/i, 'gemini-2'],
];

const KNOWN_PROVIDER_VALUES = new Set([
  'anthropic',
  'openai',
  'google',
  'gemini',
  'opencode',
  'openrouter',
  'local',
  'ollama',
]);

export function normalizeTelemetryProvider(provider: unknown): string {
  if (typeof provider !== 'string' || provider.trim() === '') return 'unknown';
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'google') return 'google';
  if (normalized === 'gemini') return 'google';
  if (normalized === 'ollama') return 'local';
  if (KNOWN_PROVIDER_VALUES.has(normalized)) return normalized;
  return 'other';
}

export function normalizeTelemetryModelFamily(model: unknown): string {
  if (typeof model !== 'string' || model.trim() === '') return 'unknown';
  const trimmed = model.trim();
  for (const [pattern, family] of KNOWN_MODEL_PATTERNS) {
    if (pattern.test(trimmed)) return family;
  }
  return 'custom';
}
