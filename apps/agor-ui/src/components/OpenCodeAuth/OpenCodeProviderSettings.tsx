import type {
  AgorClient,
  OpenCodeOAuthAttempt,
  OpenCodeProviderSettings as Settings,
} from '@agor-live/client';
import { Alert, List, Select, Space, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isActiveOAuthAttempt,
  OpenCodeProviderListItem,
  preferredOAuthMethodIndex,
  visibleAuthPrompts,
} from './OpenCodeProviderListItem';

interface ProviderAction {
  generation: number;
  actionId: number;
}

function providerListEmptyText(settings: Settings | null, error: string | undefined): string {
  if (error) return 'No provider status available';
  return settings ? 'Choose a provider to connect' : 'Loading providers';
}

export function OpenCodeProviderSettings({ client }: { client: AgorClient }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [apiKey, setApiKey] = useState('');
  const [selectedMethodIndex, setSelectedMethodIndex] = useState<number>();
  const [promptValues, setPromptValues] = useState<Record<string, string>>({});
  const [oauthAttempts, setOAuthAttempts] = useState<Record<string, OpenCodeOAuthAttempt>>({});
  const oauthAttemptsRef = useRef<Record<string, OpenCodeOAuthAttempt>>({});
  const cancellingAttemptsRef = useRef(new Set<string>());
  const [oauthCode, setOAuthCode] = useState('');
  const [busyProvider, setBusyProvider] = useState<string>();
  const [error, setError] = useState<string>();
  const actionIdRef = useRef(0);
  const selectedProviderRef = useRef<string | undefined>(undefined);
  const selectionGenerationRef = useRef(0);
  const scopeRef = useRef({ client, generation: 0 });
  if (scopeRef.current.client !== client) {
    scopeRef.current = {
      client,
      generation: scopeRef.current.generation + 1,
    };
  }
  const scopeGeneration = scopeRef.current.generation;
  const isCurrentScope = useCallback(
    (generation: number) => scopeRef.current.generation === generation,
    []
  );
  const beginAction = useCallback((providerId: string, generation: number): ProviderAction => {
    const action = { generation, actionId: ++actionIdRef.current };
    setBusyProvider(providerId);
    setError(undefined);
    return action;
  }, []);
  const isCurrentAction = useCallback(
    (action: ProviderAction) =>
      isCurrentScope(action.generation) && actionIdRef.current === action.actionId,
    [isCurrentScope]
  );
  const updateSelectedProvider = useCallback((providerId: string | undefined) => {
    if (selectedProviderRef.current === providerId) return false;
    selectedProviderRef.current = providerId;
    selectionGenerationRef.current += 1;
    actionIdRef.current += 1;
    setSelectedProviderId(providerId);
    setBusyProvider(undefined);
    return true;
  }, []);
  const isCurrentSelection = useCallback(
    (generation: number, selectionGeneration: number, providerId: string) =>
      isCurrentScope(generation) &&
      selectionGenerationRef.current === selectionGeneration &&
      selectedProviderRef.current === providerId,
    [isCurrentScope]
  );

  const clearFormState = useCallback(() => {
    setApiKey('');
    setSelectedMethodIndex(undefined);
    setPromptValues({});
    setOAuthCode('');
  }, []);

  const storeAttempt = useCallback(
    (providerId: string, attempt: OpenCodeOAuthAttempt, generation: number) => {
      if (!isCurrentScope(generation)) return false;
      oauthAttemptsRef.current = { ...oauthAttemptsRef.current, [providerId]: attempt };
      setOAuthAttempts(oauthAttemptsRef.current);
      return true;
    },
    [isCurrentScope]
  );

  useEffect(() => {
    const generation = scopeGeneration;
    setSettings(null);
    updateSelectedProvider(undefined);
    clearFormState();
    oauthAttemptsRef.current = {};
    setOAuthAttempts({});
    cancellingAttemptsRef.current.clear();
    setBusyProvider(undefined);
    setError(undefined);
    void client
      .service('opencode-auth')
      .find()
      .then((next) => {
        if (isCurrentScope(generation)) setSettings(next);
      })
      .catch(() => {
        if (isCurrentScope(generation)) {
          setError('OpenCode provider settings could not be loaded.');
        }
      });
  }, [clearFormState, client, isCurrentScope, scopeGeneration, updateSelectedProvider]);

  useEffect(() => {
    const generation = scopeGeneration;
    const selectionGeneration = selectionGenerationRef.current;
    const actionId = actionIdRef.current;
    const active = Object.entries(oauthAttempts).filter(
      ([providerId, attempt]) => providerId === selectedProviderId && isActiveOAuthAttempt(attempt)
    );
    if (active.length === 0 || busyProvider) return;
    let disposed = false;
    const timers = new Set<number>();
    const ownsSelection = (providerId: string) =>
      !disposed &&
      actionIdRef.current === actionId &&
      isCurrentSelection(generation, selectionGeneration, providerId);
    const activeAttempt = (providerId: string, attemptId: string) => {
      const attempt = oauthAttemptsRef.current[providerId];
      return attempt?.attemptId === attemptId && isActiveOAuthAttempt(attempt)
        ? attempt
        : undefined;
    };
    const canCommitAttempt = (providerId: string, attemptId: string) =>
      ownsSelection(providerId) &&
      !cancellingAttemptsRef.current.has(attemptId) &&
      Boolean(activeAttempt(providerId, attemptId));
    const schedule = (providerId: string, attemptId: string) => {
      const timer = window.setTimeout(async () => {
        timers.delete(timer);
        if (!ownsSelection(providerId)) return;
        if (!activeAttempt(providerId, attemptId) || cancellingAttemptsRef.current.has(attemptId)) {
          if (activeAttempt(providerId, attemptId)) schedule(providerId, attemptId);
          return;
        }
        try {
          const next = await client.service('opencode-auth').get(attemptId);
          if (!canCommitAttempt(providerId, attemptId) || next.attemptId !== attemptId) return;
          storeAttempt(providerId, next, generation);
          if (next.phase === 'configured' && next.settings) setSettings(next.settings);
        } catch {
          if (canCommitAttempt(providerId, attemptId)) {
            setError('OpenCode authorization status could not be refreshed.');
          }
        } finally {
          if (ownsSelection(providerId) && activeAttempt(providerId, attemptId)) {
            schedule(providerId, attemptId);
          }
        }
      }, 1000);
      timers.add(timer);
    };
    for (const [providerId, attempt] of active) schedule(providerId, attempt.attemptId);
    return () => {
      disposed = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [
    busyProvider,
    client,
    isCurrentSelection,
    oauthAttempts,
    scopeGeneration,
    selectedProviderId,
    storeAttempt,
  ]);

  const connectableProviders = useMemo(
    () => settings?.providers.filter((provider) => provider.credentialPresence !== 'present') ?? [],
    [settings]
  );
  const selectedProvider = connectableProviders.find(
    (provider) => provider.id === selectedProviderId
  );
  const visibleProviders =
    settings?.providers.filter(
      (provider) =>
        provider.credentialPresence === 'present' ||
        provider.runtimeAvailable ||
        provider.id === selectedProvider?.id
    ) ?? [];

  useEffect(() => {
    if (!settings) return;
    if (
      selectedProviderId &&
      !settings.providers.some(
        (provider) =>
          provider.id === selectedProviderId && provider.credentialPresence !== 'present'
      )
    ) {
      updateSelectedProvider(undefined);
      clearFormState();
      return;
    }
    if (!selectedProviderId && connectableProviders.length === 1) {
      updateSelectedProvider(connectableProviders[0].id);
    }
  }, [clearFormState, connectableProviders, selectedProviderId, settings, updateSelectedProvider]);

  const selectProvider = (providerId: string | undefined) => {
    if (!updateSelectedProvider(providerId)) return;
    clearFormState();
    setError(undefined);
  };

  const runProviderAction = async <T,>(
    providerId: string,
    failureMessage: string,
    operation: () => Promise<T>,
    onSuccess: (result: T, generation: number) => void
  ) => {
    const action = beginAction(providerId, scopeGeneration);
    try {
      const result = await operation();
      if (isCurrentAction(action)) onSuccess(result, action.generation);
    } catch {
      if (isCurrentAction(action)) setError(failureMessage);
    } finally {
      if (isCurrentAction(action)) setBusyProvider(undefined);
    }
  };

  const connect = async (providerId: string) => {
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) return;
    const provider = settings?.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const methodPosition = selectedMethodIndex ?? preferredOAuthMethodIndex(provider.authMethods);
    const method = provider.authMethods[methodPosition];
    if (method && method.type !== 'api') return;
    const visiblePrompts = visibleAuthPrompts(method?.prompts, promptValues);
    if (visiblePrompts.some((prompt) => !promptValues[prompt.key]?.trim())) return;
    const metadata = Object.fromEntries(
      visiblePrompts.map((prompt) => [prompt.key, promptValues[prompt.key].trim()])
    );
    await runProviderAction(
      providerId,
      'OpenCode could not configure that provider.',
      () =>
        client.service('opencode-auth').create({
          providerId,
          apiKey: trimmedApiKey,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        }) as Promise<Settings>,
      (next) => {
        setSettings(next);
        setApiKey('');
        setPromptValues({});
      }
    );
  };

  const connectOAuth = async (providerId: string) => {
    const provider = settings?.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const methodPosition = selectedMethodIndex ?? preferredOAuthMethodIndex(provider.authMethods);
    const method = provider.authMethods[methodPosition];
    if (method?.type !== 'oauth') return;
    const visiblePrompts = visibleAuthPrompts(method.prompts, promptValues);
    if (visiblePrompts.some((prompt) => !promptValues[prompt.key]?.trim())) return;
    const inputs = Object.fromEntries(
      visiblePrompts.map((prompt) => [prompt.key, promptValues[prompt.key].trim()])
    );
    await runProviderAction(
      providerId,
      'OpenCode could not start native authorization.',
      () =>
        client.service('opencode-auth').create({
          operation: 'connect-oauth',
          providerId,
          method: method.index,
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        }) as Promise<OpenCodeOAuthAttempt>,
      (attempt, generation) => {
        if (!storeAttempt(providerId, attempt, generation)) return;
        if (attempt.phase === 'configured' && attempt.settings) setSettings(attempt.settings);
      }
    );
  };

  const cancelOAuth = async (providerId: string) => {
    const attempt = oauthAttempts[providerId];
    if (!attempt) return;
    cancellingAttemptsRef.current.add(attempt.attemptId);
    try {
      await runProviderAction(
        providerId,
        'OpenCode authorization could not be cancelled.',
        () => client.service('opencode-auth').patch(attempt.attemptId, { cancel: true }),
        (cancelled, generation) => {
          if (oauthAttemptsRef.current[providerId]?.attemptId === attempt.attemptId) {
            storeAttempt(providerId, cancelled, generation);
          }
        }
      );
    } finally {
      cancellingAttemptsRef.current.delete(attempt.attemptId);
    }
  };

  const submitOAuthCode = async (providerId: string) => {
    const attempt = oauthAttemptsRef.current[providerId];
    const code = oauthCode.trim();
    if (!attempt || !code) return;
    setOAuthCode('');
    await runProviderAction(
      providerId,
      'OpenCode authorization code could not be submitted.',
      () => client.service('opencode-auth').patch(attempt.attemptId, { code }),
      (next, generation) => {
        if (oauthAttemptsRef.current[providerId]?.attemptId === attempt.attemptId) {
          storeAttempt(providerId, next, generation);
        }
      }
    );
  };

  const disconnect = async (providerId: string) => {
    await runProviderAction(
      providerId,
      'OpenCode could not disconnect that provider.',
      () => client.service('opencode-auth').remove(providerId),
      (next) => setSettings(next)
    );
  };

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Connect providers through native API-key or subscription authorization in the managed
        OpenCode runtime.
      </Typography.Paragraph>
      {settings && (
        <Alert
          type={settings.isolation.boundary === 'os' ? 'success' : 'warning'}
          showIcon
          title={
            settings.isolation.boundary === 'os'
              ? 'Credentials are isolated by the session owner’s Unix identity.'
              : 'Credentials use separate logical namespaces under a shared Unix identity.'
          }
          description={
            settings.isolation.boundary === 'os'
              ? 'Strict mode enforces the credential boundary with filesystem ownership and permissions.'
              : 'Simple and insulated modes require users who share the Unix identity to trust one another.'
          }
        />
      )}
      {error && <Alert type="error" showIcon title={error} />}
      <Select
        allowClear
        showSearch
        aria-label="Provider to connect"
        placeholder="Search for a provider to connect"
        value={selectedProviderId}
        optionFilterProp="searchText"
        options={connectableProviders.map((provider) => ({
          value: provider.id,
          label: provider.name,
          searchText: `${provider.name} ${provider.id}`,
        }))}
        onChange={selectProvider}
        style={{ width: '100%' }}
      />
      <List
        loading={!settings && !error}
        dataSource={visibleProviders}
        locale={{ emptyText: providerListEmptyText(settings, error) }}
        renderItem={(provider) => (
          <OpenCodeProviderListItem
            provider={provider}
            selected={provider.id === selectedProviderId}
            selectedMethodIndex={selectedMethodIndex}
            promptValues={promptValues}
            apiKey={apiKey}
            oauthCode={oauthCode}
            oauthAttempt={oauthAttempts[provider.id]}
            busy={busyProvider === provider.id}
            onConnect={() => connect(provider.id)}
            onConnectOAuth={() => connectOAuth(provider.id)}
            onCancelOAuth={() => cancelOAuth(provider.id)}
            onDisconnect={() => disconnect(provider.id)}
            onSubmitOAuthCode={() => void submitOAuthCode(provider.id)}
            onMethodChange={(index) => {
              setSelectedMethodIndex(index);
              setApiKey('');
              setPromptValues({});
              setOAuthCode('');
            }}
            onPromptChange={(key, value) =>
              setPromptValues((current) => ({ ...current, [key]: value }))
            }
            onApiKeyChange={setApiKey}
            onOAuthCodeChange={setOAuthCode}
          />
        )}
      />
      {settings && (
        <Typography.Text type="secondary">
          Managed OpenCode runtime {settings.runtimeVersion}
        </Typography.Text>
      )}
    </Space>
  );
}
