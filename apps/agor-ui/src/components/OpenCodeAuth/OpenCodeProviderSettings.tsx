import type {
  AgorClient,
  OpenCodeOAuthAttempt,
  OpenCodeProviderAuthPrompt,
  OpenCodeProviderSettings as Settings,
} from '@agor-live/client';
import { Alert, Button, Input, List, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ACTIVE_OAUTH_PHASES = new Set(['authorizing', 'awaiting_callback', 'completing']);

function isActiveOAuthAttempt(attempt?: OpenCodeOAuthAttempt): boolean {
  return Boolean(attempt && ACTIVE_OAUTH_PHASES.has(attempt.phase));
}

function visibleAuthPrompts(
  prompts: OpenCodeProviderAuthPrompt[] | undefined,
  values: Record<string, string>
): OpenCodeProviderAuthPrompt[] {
  return (
    prompts?.filter((prompt) => {
      if (!prompt.when) return true;
      const matches = values[prompt.when.key] === prompt.when.value;
      return prompt.when.op === 'eq' ? matches : !matches;
    }) ?? []
  );
}

function AuthPromptFields({
  prompts,
  values,
  onChange,
}: {
  prompts: OpenCodeProviderAuthPrompt[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return prompts.map((prompt) =>
    prompt.type === 'select' ? (
      <Select
        key={prompt.key}
        aria-label={prompt.message}
        placeholder={prompt.message}
        value={values[prompt.key]}
        options={prompt.options}
        onChange={(value) => onChange(prompt.key, value)}
      />
    ) : (
      <Input
        key={prompt.key}
        aria-label={prompt.message}
        placeholder={prompt.placeholder ?? prompt.message}
        value={values[prompt.key] ?? ''}
        onChange={(event) => onChange(prompt.key, event.target.value)}
      />
    )
  );
}

function preferredOAuthMethodIndex(methods: Array<{ label: string }>): number {
  const headless = methods.findIndex((method) => /headless/i.test(method.label));
  return headless >= 0 ? headless : 0;
}

interface ProviderAction {
  generation: number;
  actionId: number;
}

export function OpenCodeProviderSettings({ client }: { client: AgorClient }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [methodIndexes, setMethodIndexes] = useState<Record<string, number>>({});
  const [promptValues, setPromptValues] = useState<Record<string, Record<string, string>>>({});
  const [oauthAttempts, setOAuthAttempts] = useState<Record<string, OpenCodeOAuthAttempt>>({});
  const oauthAttemptsRef = useRef<Record<string, OpenCodeOAuthAttempt>>({});
  const cancellingAttemptsRef = useRef(new Set<string>());
  const [oauthCodes, setOAuthCodes] = useState<Record<string, string>>({});
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
    setKeys({});
    setMethodIndexes({});
    setPromptValues({});
    setOAuthCodes({});
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
    const schedule = (providerId: string, attemptId: string) => {
      const timer = window.setTimeout(async () => {
        timers.delete(timer);
        if (
          disposed ||
          actionIdRef.current !== actionId ||
          !isCurrentSelection(generation, selectionGeneration, providerId)
        ) {
          return;
        }
        const before = oauthAttemptsRef.current[providerId];
        if (
          !before ||
          before.attemptId !== attemptId ||
          !isActiveOAuthAttempt(before) ||
          cancellingAttemptsRef.current.has(attemptId)
        ) {
          if (before?.attemptId === attemptId && isActiveOAuthAttempt(before)) {
            schedule(providerId, attemptId);
          }
          return;
        }
        try {
          const next = await client.service('opencode-auth').get(attemptId);
          const current = oauthAttemptsRef.current[providerId];
          if (
            disposed ||
            actionIdRef.current !== actionId ||
            !isCurrentSelection(generation, selectionGeneration, providerId) ||
            cancellingAttemptsRef.current.has(attemptId) ||
            !current ||
            current.attemptId !== attemptId ||
            !isActiveOAuthAttempt(current) ||
            next.attemptId !== attemptId
          ) {
            return;
          }
          storeAttempt(providerId, next, generation);
          if (next.phase === 'configured' && next.settings) setSettings(next.settings);
        } catch {
          const current = oauthAttemptsRef.current[providerId];
          if (
            !disposed &&
            actionIdRef.current === actionId &&
            isCurrentSelection(generation, selectionGeneration, providerId) &&
            !cancellingAttemptsRef.current.has(attemptId) &&
            current?.attemptId === attemptId &&
            isActiveOAuthAttempt(current)
          ) {
            setError('OpenCode authorization status could not be refreshed.');
          }
        } finally {
          const current = oauthAttemptsRef.current[providerId];
          if (
            !disposed &&
            actionIdRef.current === actionId &&
            isCurrentSelection(generation, selectionGeneration, providerId) &&
            current?.attemptId === attemptId &&
            isActiveOAuthAttempt(current)
          ) {
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

  const connect = async (providerId: string) => {
    const generation = scopeGeneration;
    const apiKey = keys[providerId]?.trim();
    if (!apiKey) return;
    const provider = settings?.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const methodPosition =
      methodIndexes[providerId] ?? preferredOAuthMethodIndex(provider.authMethods);
    const method = provider.authMethods[methodPosition];
    if (method && method.type !== 'api') return;
    const values = promptValues[providerId] ?? {};
    const visiblePrompts = visibleAuthPrompts(method?.prompts, values);
    if (visiblePrompts.some((prompt) => !values[prompt.key]?.trim())) return;
    const metadata = Object.fromEntries(
      visiblePrompts.map((prompt) => [prompt.key, values[prompt.key].trim()])
    );
    const action = beginAction(providerId, generation);
    try {
      const next = (await client.service('opencode-auth').create({
        providerId,
        apiKey,
        ...(Object.keys(metadata).length ? { metadata } : {}),
      })) as Settings;
      if (!isCurrentAction(action)) return;
      setSettings(next);
      setKeys((current) => ({ ...current, [providerId]: '' }));
      setPromptValues((current) => ({ ...current, [providerId]: {} }));
    } catch {
      if (isCurrentAction(action)) {
        setError('OpenCode could not configure that provider.');
      }
    } finally {
      if (isCurrentAction(action)) setBusyProvider(undefined);
    }
  };

  const connectOAuth = async (providerId: string) => {
    const generation = scopeGeneration;
    const provider = settings?.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const methodPosition =
      methodIndexes[providerId] ?? preferredOAuthMethodIndex(provider.authMethods);
    const method = provider.authMethods[methodPosition];
    if (method?.type !== 'oauth') return;
    const values = promptValues[providerId] ?? {};
    const visiblePrompts = visibleAuthPrompts(method.prompts, values);
    if (visiblePrompts.some((prompt) => !values[prompt.key]?.trim())) return;
    const inputs = Object.fromEntries(
      visiblePrompts.map((prompt) => [prompt.key, values[prompt.key].trim()])
    );
    const action = beginAction(providerId, generation);
    try {
      const attempt = (await client.service('opencode-auth').create({
        operation: 'connect-oauth',
        providerId,
        method: method.index,
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      })) as OpenCodeOAuthAttempt;
      if (!isCurrentAction(action) || !storeAttempt(providerId, attempt, generation)) return;
      if (attempt.phase === 'configured' && attempt.settings) setSettings(attempt.settings);
    } catch {
      if (isCurrentAction(action)) {
        setError('OpenCode could not start native authorization.');
      }
    } finally {
      if (isCurrentAction(action)) setBusyProvider(undefined);
    }
  };

  const cancelOAuth = async (providerId: string) => {
    const generation = scopeGeneration;
    const attempt = oauthAttempts[providerId];
    if (!attempt) return;
    cancellingAttemptsRef.current.add(attempt.attemptId);
    const action = beginAction(providerId, generation);
    try {
      const cancelled = await client
        .service('opencode-auth')
        .patch(attempt.attemptId, { cancel: true });
      if (
        isCurrentAction(action) &&
        oauthAttemptsRef.current[providerId]?.attemptId === attempt.attemptId
      ) {
        storeAttempt(providerId, cancelled, generation);
      }
    } catch {
      if (isCurrentAction(action)) {
        setError('OpenCode authorization could not be cancelled.');
      }
    } finally {
      cancellingAttemptsRef.current.delete(attempt.attemptId);
      if (isCurrentAction(action)) setBusyProvider(undefined);
    }
  };

  const submitOAuthCode = async (providerId: string) => {
    const generation = scopeGeneration;
    const attempt = oauthAttemptsRef.current[providerId];
    const code = oauthCodes[providerId]?.trim();
    if (!attempt || !code) return;
    setOAuthCodes((current) => ({ ...current, [providerId]: '' }));
    const action = beginAction(providerId, generation);
    try {
      const next = await client.service('opencode-auth').patch(attempt.attemptId, { code });
      if (
        isCurrentAction(action) &&
        oauthAttemptsRef.current[providerId]?.attemptId === attempt.attemptId
      ) {
        storeAttempt(providerId, next, generation);
      }
    } catch {
      if (isCurrentAction(action)) {
        setError('OpenCode authorization code could not be submitted.');
      }
    } finally {
      if (isCurrentAction(action)) setBusyProvider(undefined);
    }
  };

  const disconnect = async (providerId: string) => {
    const generation = scopeGeneration;
    const action = beginAction(providerId, generation);
    try {
      const next = await client.service('opencode-auth').remove(providerId);
      if (isCurrentAction(action)) setSettings(next);
    } catch {
      if (isCurrentAction(action)) {
        setError('OpenCode could not disconnect that provider.');
      }
    } finally {
      if (isCurrentAction(action)) setBusyProvider(undefined);
    }
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
        locale={{
          emptyText: error
            ? 'No provider status available'
            : settings
              ? 'Choose a provider to connect'
              : 'Loading providers',
        }}
        renderItem={(provider) => {
          const methodIndex =
            methodIndexes[provider.id] ?? preferredOAuthMethodIndex(provider.authMethods);
          const method = provider.authMethods[methodIndex];
          const apiKeyAvailable =
            method?.type === 'api' ||
            (!method && (!provider.runtimeAvailable || provider.credentialPresence !== 'absent'));
          const values = promptValues[provider.id] ?? {};
          const visiblePrompts = visibleAuthPrompts(method?.prompts, values);
          const promptsComplete = visiblePrompts.every((prompt) => values[prompt.key]?.trim());
          const oauthMethod = method?.type === 'oauth' ? method : undefined;
          const oauthAttempt = oauthAttempts[provider.id];
          const oauthActive = isActiveOAuthAttempt(oauthAttempt);

          return (
            <List.Item
              actions={[
                provider.credentialPresence === 'present' ? (
                  <Popconfirm
                    key="remove-credential"
                    title={`Remove the saved credential for ${provider.name}?`}
                    onConfirm={() => disconnect(provider.id)}
                  >
                    <Button danger loading={busyProvider === provider.id}>
                      Remove
                    </Button>
                  </Popconfirm>
                ) : apiKeyAvailable ? (
                  <Button
                    key="connect"
                    type="primary"
                    loading={busyProvider === provider.id}
                    disabled={!keys[provider.id]?.trim() || !promptsComplete}
                    onClick={() => connect(provider.id)}
                  >
                    Connect
                  </Button>
                ) : null,
                provider.credentialPresence !== 'present' && oauthMethod && !oauthActive ? (
                  <Button
                    key="oauth-connect"
                    loading={busyProvider === provider.id}
                    disabled={!promptsComplete}
                    onClick={() => connectOAuth(provider.id)}
                  >
                    Connect with {oauthMethod.label}
                  </Button>
                ) : null,
                provider.credentialPresence !== 'present' && oauthActive ? (
                  <Button
                    key="oauth-cancel"
                    danger
                    loading={busyProvider === provider.id}
                    onClick={() => cancelOAuth(provider.id)}
                  >
                    Cancel authorization
                  </Button>
                ) : null,
              ].filter(Boolean)}
              style={{ alignItems: 'flex-end' }}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Typography.Text strong>{provider.name}</Typography.Text>
                    {provider.runtimeAvailable && <Tag color="blue">Available in runtime</Tag>}
                    {provider.credentialPresence === 'present' && (
                      <Tag color="green">Saved credential</Tag>
                    )}
                    {provider.credentialPresence === 'unknown' && (
                      <Tag color="gold">Credential state unknown</Tag>
                    )}
                  </Space>
                }
                description={
                  provider.credentialPresence === 'present' ? (
                    <Typography.Text type="secondary">
                      A saved credential exists; provider access is not verified here.
                    </Typography.Text>
                  ) : (
                    <Space orientation="vertical" style={{ width: '100%' }}>
                      {provider.credentialPresence === 'unknown' ? (
                        <Typography.Text type="secondary">
                          Saved credential presence could not be determined. Removal is unavailable
                          until discovery can read the native credential store.
                        </Typography.Text>
                      ) : provider.runtimeAvailable ? (
                        <Typography.Text type="secondary">
                          Available in the OpenCode runtime without a saved credential. Runtime
                          availability may be built in and does not imply removable credentials.
                        </Typography.Text>
                      ) : null}
                      {oauthActive && oauthAttempt.authorization && (
                        <Alert
                          type="info"
                          showIcon
                          title="Authorization in progress"
                          description={
                            <Space orientation="vertical">
                              <Typography.Text>
                                {oauthAttempt.authorization.instructions}
                              </Typography.Text>
                              <Typography.Link
                                href={oauthAttempt.authorization.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open authorization page
                              </Typography.Link>
                              {oauthAttempt.authorization.method === 'code' &&
                                oauthAttempt.phase === 'awaiting_callback' && (
                                  <Space.Compact>
                                    <Input.Password
                                      aria-label={`${provider.name} authorization code`}
                                      autoComplete="one-time-code"
                                      placeholder="Authorization code"
                                      value={oauthCodes[provider.id] ?? ''}
                                      onChange={(event) =>
                                        setOAuthCodes((current) => ({
                                          ...current,
                                          [provider.id]: event.target.value,
                                        }))
                                      }
                                      onPressEnter={() => void submitOAuthCode(provider.id)}
                                    />
                                    <Button
                                      loading={busyProvider === provider.id}
                                      disabled={!oauthCodes[provider.id]?.trim()}
                                      onClick={() => submitOAuthCode(provider.id)}
                                    >
                                      Submit authorization code
                                    </Button>
                                  </Space.Compact>
                                )}
                            </Space>
                          }
                        />
                      )}
                      {oauthAttempt &&
                        ['failed', 'expired', 'cancelled'].includes(oauthAttempt.phase) && (
                          <Alert
                            type={oauthAttempt.phase === 'cancelled' ? 'info' : 'error'}
                            showIcon
                            title={
                              oauthAttempt.phase === 'expired'
                                ? 'Authorization expired.'
                                : oauthAttempt.phase === 'cancelled'
                                  ? 'Authorization cancelled.'
                                  : 'Authorization failed.'
                            }
                          />
                        )}
                      {provider.authMethods.length > 1 && !oauthActive && (
                        <Select
                          aria-label={`${provider.name} authentication method`}
                          value={methodIndex}
                          options={provider.authMethods.map((candidate, index) => ({
                            label: candidate.label,
                            value: index,
                          }))}
                          onChange={(index) => {
                            setMethodIndexes((current) => ({
                              ...current,
                              [provider.id]: index,
                            }));
                            setKeys((current) => ({ ...current, [provider.id]: '' }));
                            setPromptValues((current) => ({
                              ...current,
                              [provider.id]: {},
                            }));
                            setOAuthCodes((current) => ({
                              ...current,
                              [provider.id]: '',
                            }));
                          }}
                          style={{ width: '100%' }}
                        />
                      )}
                      {!oauthActive && (
                        <AuthPromptFields
                          prompts={visiblePrompts}
                          values={values}
                          onChange={(key, value) =>
                            setPromptValues((current) => ({
                              ...current,
                              [provider.id]: { ...current[provider.id], [key]: value },
                            }))
                          }
                        />
                      )}
                      {apiKeyAvailable && !oauthActive && (
                        <Input.Password
                          aria-label={`${provider.name} API key`}
                          autoComplete="new-password"
                          placeholder="API key"
                          value={keys[provider.id] ?? ''}
                          onChange={(event) =>
                            setKeys((current) => ({
                              ...current,
                              [provider.id]: event.target.value,
                            }))
                          }
                          onPressEnter={() => void connect(provider.id)}
                        />
                      )}
                    </Space>
                  )
                }
              />
            </List.Item>
          );
        }}
      />
      {settings && (
        <Typography.Text type="secondary">
          Managed OpenCode runtime {settings.runtimeVersion}
        </Typography.Text>
      )}
    </Space>
  );
}
