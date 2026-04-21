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
