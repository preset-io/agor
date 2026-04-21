export type CodexAuthStrategy =
  | {
      kind: 'api_key';
      apiKey: string;
    }
  | {
      kind: 'native';
    };

export function createCodexAuthStrategy(
  apiKey: string | undefined,
  useNativeAuth: boolean | undefined
): CodexAuthStrategy {
  if (apiKey && apiKey.trim().length > 0) {
    return {
      kind: 'api_key',
      apiKey,
    };
  }

  if (useNativeAuth) {
    return {
      kind: 'native',
    };
  }

  return {
    kind: 'native',
  };
}

export function buildCodexClientOptions(strategy: CodexAuthStrategy): { apiKey?: string } {
  if (strategy.kind === 'api_key') {
    return { apiKey: strategy.apiKey };
  }

  return {};
}

export function getCodexAuthStrategyCacheKey(strategy: CodexAuthStrategy): string {
  if (strategy.kind === 'api_key') {
    return `api_key:${strategy.apiKey}`;
  }

  return 'native';
}

export function getCodexAuthFailureGuidance(
  strategy: CodexAuthStrategy,
  errorMessage: string
): string {
  if (strategy.kind === 'native') {
    if (errorMessage.includes('Missing bearer')) {
      return 'Codex native auth is not configured. Run `codex login` and retry.';
    }

    return 'Codex native auth failed. Run `codex login` again and retry.';
  }

  if (errorMessage.includes('Missing bearer')) {
    return 'No OPENAI_API_KEY is configured. Please add your API key in Settings > API Keys.';
  }

  return 'Your OPENAI_API_KEY may be invalid or expired. Please check Settings > API Keys.';
}
