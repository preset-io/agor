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

export function OpenCodeProviderSettings({ client }: { client: AgorClient }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [query, setQuery] = useState('');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [methodIndexes, setMethodIndexes] = useState<Record<string, number>>({});
  const [oauthMethodIndexes, setOAuthMethodIndexes] = useState<Record<string, number>>({});
  const [promptValues, setPromptValues] = useState<Record<string, Record<string, string>>>({});
  const [oauthPromptValues, setOAuthPromptValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const [oauthAttempts, setOAuthAttempts] = useState<Record<string, OpenCodeOAuthAttempt>>({});
  const oauthAttemptsRef = useRef<Record<string, OpenCodeOAuthAttempt>>({});
  const cancellingAttemptsRef = useRef(new Set<string>());
  const [oauthCodes, setOAuthCodes] = useState<Record<string, string>>({});
  const [busyProvider, setBusyProvider] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setSettings(await client.service('opencode-auth').find());
    } catch {
      setError('OpenCode provider settings could not be loaded.');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const active = Object.entries(oauthAttempts).filter(([, attempt]) =>
      isActiveOAuthAttempt(attempt)
    );
    if (active.length === 0) return;
    let disposed = false;
    const timers = new Set<number>();
    const schedule = (providerId: string, attemptId: string) => {
      const timer = window.setTimeout(async () => {
        timers.delete(timer);
        if (disposed) return;
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
            cancellingAttemptsRef.current.has(attemptId) ||
            !current ||
            current.attemptId !== attemptId ||
            !isActiveOAuthAttempt(current) ||
            next.attemptId !== attemptId
          ) {
            return;
          }
          oauthAttemptsRef.current = {
            ...oauthAttemptsRef.current,
            [providerId]: next,
          };
          setOAuthAttempts(oauthAttemptsRef.current);
          if (next.phase === 'configured' && next.settings) setSettings(next.settings);
        } catch {
          const current = oauthAttemptsRef.current[providerId];
          if (
            !disposed &&
            !cancellingAttemptsRef.current.has(attemptId) &&
            current?.attemptId === attemptId &&
            isActiveOAuthAttempt(current)
          ) {
            setError('OpenCode authorization status could not be refreshed.');
          }
        } finally {
          const current = oauthAttemptsRef.current[providerId];
          if (!disposed && current?.attemptId === attemptId && isActiveOAuthAttempt(current)) {
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
  }, [client, oauthAttempts]);

  const storeAttempt = useCallback((providerId: string, attempt: OpenCodeOAuthAttempt) => {
    oauthAttemptsRef.current = { ...oauthAttemptsRef.current, [providerId]: attempt };
    setOAuthAttempts(oauthAttemptsRef.current);
  }, []);

  const providers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return settings?.providers ?? [];
    return (settings?.providers ?? []).filter(
      (provider) =>
        provider.name.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle)
    );
  }, [query, settings]);

  const connect = async (providerId: string) => {
    const apiKey = keys[providerId]?.trim();
    if (!apiKey) return;
    const provider = settings?.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const apiMethods = provider?.authMethods.filter((method) => method.type === 'api') ?? [];
    const apiKeyAvailable = apiMethods.length > 0 || provider.authMethods.length === 0;
    if (!apiKeyAvailable) return;
    const method = apiMethods[methodIndexes[providerId] ?? 0];
    const values = promptValues[providerId] ?? {};
    const visiblePrompts = visibleAuthPrompts(method?.prompts, values);
    if (visiblePrompts.some((prompt) => !values[prompt.key]?.trim())) return;
    const metadata = Object.fromEntries(
      visiblePrompts.map((prompt) => [prompt.key, values[prompt.key].trim()])
    );
    setBusyProvider(providerId);
    setError(undefined);
    try {
      setSettings(
        (await client.service('opencode-auth').create({
          providerId,
          apiKey,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        })) as Settings
      );
      setKeys((current) => ({ ...current, [providerId]: '' }));
      setPromptValues((current) => ({ ...current, [providerId]: {} }));
    } catch {
      setError('OpenCode could not configure that provider.');
    } finally {
      setBusyProvider(undefined);
    }
  };

  const connectOAuth = async (providerId: string) => {
    const provider = settings?.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const methods = provider.authMethods.filter((method) => method.type === 'oauth');
    const method = methods[oauthMethodIndexes[providerId] ?? preferredOAuthMethodIndex(methods)];
    if (!method) return;
    const values = oauthPromptValues[providerId] ?? {};
    const visiblePrompts = visibleAuthPrompts(method.prompts, values);
    if (visiblePrompts.some((prompt) => !values[prompt.key]?.trim())) return;
    const inputs = Object.fromEntries(
      visiblePrompts.map((prompt) => [prompt.key, values[prompt.key].trim()])
    );
    setBusyProvider(providerId);
    setError(undefined);
    try {
      const attempt = (await client.service('opencode-auth').create({
        operation: 'connect-oauth',
        providerId,
        method: method.index,
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      })) as OpenCodeOAuthAttempt;
      storeAttempt(providerId, attempt);
      if (attempt.phase === 'configured' && attempt.settings) setSettings(attempt.settings);
    } catch {
      setError('OpenCode could not start native authorization.');
    } finally {
      setBusyProvider(undefined);
    }
  };

  const cancelOAuth = async (providerId: string) => {
    const attempt = oauthAttempts[providerId];
    if (!attempt) return;
    cancellingAttemptsRef.current.add(attempt.attemptId);
    setBusyProvider(providerId);
    setError(undefined);
    try {
      const cancelled = await client
        .service('opencode-auth')
        .patch(attempt.attemptId, { cancel: true });
      if (oauthAttemptsRef.current[providerId]?.attemptId === attempt.attemptId) {
        storeAttempt(providerId, cancelled);
      }
    } catch {
      setError('OpenCode authorization could not be cancelled.');
    } finally {
      cancellingAttemptsRef.current.delete(attempt.attemptId);
      setBusyProvider(undefined);
    }
  };

  const submitOAuthCode = async (providerId: string) => {
    const attempt = oauthAttemptsRef.current[providerId];
    const code = oauthCodes[providerId]?.trim();
    if (!attempt || !code) return;
    setOAuthCodes((current) => ({ ...current, [providerId]: '' }));
    setBusyProvider(providerId);
    setError(undefined);
    try {
      const next = await client.service('opencode-auth').patch(attempt.attemptId, { code });
      if (oauthAttemptsRef.current[providerId]?.attemptId === attempt.attemptId) {
        storeAttempt(providerId, next);
      }
    } catch {
      setError('OpenCode authorization code could not be submitted.');
    } finally {
      setBusyProvider(undefined);
    }
  };

  const disconnect = async (providerId: string) => {
    setBusyProvider(providerId);
    setError(undefined);
    try {
      setSettings(await client.service('opencode-auth').remove(providerId));
    } catch {
      setError('OpenCode could not disconnect that provider.');
    } finally {
      setBusyProvider(undefined);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
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
      <Input.Search
        allowClear
        placeholder="Search OpenCode providers"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <List
        loading={!settings && !error}
        dataSource={providers}
        locale={{ emptyText: error ? 'No provider status available' : 'No matching providers' }}
        renderItem={(provider) => {
          const apiMethods = provider.authMethods.filter((method) => method.type === 'api');
          const oauthMethods = provider.authMethods.filter((method) => method.type === 'oauth');
          const apiKeyAvailable = apiMethods.length > 0 || provider.authMethods.length === 0;
          const methodIndex = methodIndexes[provider.id] ?? 0;
          const method = apiMethods[methodIndex];
          const values = promptValues[provider.id] ?? {};
          const visiblePrompts = visibleAuthPrompts(method?.prompts, values);
          const promptsComplete = visiblePrompts.every((prompt) => values[prompt.key]?.trim());
          const oauthMethodIndex =
            oauthMethodIndexes[provider.id] ?? preferredOAuthMethodIndex(oauthMethods);
          const oauthMethod = oauthMethods[oauthMethodIndex];
          const oauthValues = oauthPromptValues[provider.id] ?? {};
          const visibleOAuthPrompts = visibleAuthPrompts(oauthMethod?.prompts, oauthValues);
          const oauthPromptsComplete = visibleOAuthPrompts.every((prompt) =>
            oauthValues[prompt.key]?.trim()
          );
          const oauthAttempt = oauthAttempts[provider.id];
          const oauthActive = isActiveOAuthAttempt(oauthAttempt);

          return (
            <List.Item
              actions={[
                provider.configured ? (
                  <Popconfirm
                    key="disconnect"
                    title={`Disconnect ${provider.name}?`}
                    onConfirm={() => disconnect(provider.id)}
                  >
                    <Button danger loading={busyProvider === provider.id}>
                      Disconnect
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
                !provider.configured && oauthMethod && !oauthActive ? (
                  <Button
                    key="oauth-connect"
                    loading={busyProvider === provider.id}
                    disabled={!oauthPromptsComplete}
                    onClick={() => connectOAuth(provider.id)}
                  >
                    Connect with {oauthMethod.label}
                  </Button>
                ) : null,
                !provider.configured && oauthActive ? (
                  <Button
                    key="oauth-cancel"
                    danger
                    loading={busyProvider === provider.id}
                    onClick={() => cancelOAuth(provider.id)}
                  >
                    Cancel authorization
                  </Button>
                ) : null,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Typography.Text strong>{provider.name}</Typography.Text>
                    {provider.configured && <Tag color="green">Configured in OpenCode</Tag>}
                  </Space>
                }
                description={
                  provider.configured ? (
                    <Typography.Text type="secondary">
                      OpenCode reports a saved credential; provider access is not verified here.
                    </Typography.Text>
                  ) : (
                    <Space direction="vertical" style={{ width: '100%' }}>
                      {oauthActive && oauthAttempt.authorization && (
                        <Alert
                          type="info"
                          showIcon
                          title="Authorization in progress"
                          description={
                            <Space direction="vertical">
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
                      {apiKeyAvailable && (
                        <>
                          {apiMethods.length > 1 && (
                            <Select
                              aria-label={`${provider.name} authentication method`}
                              value={methodIndex}
                              options={apiMethods.map((candidate, index) => ({
                                label: candidate.label ?? `API key method ${index + 1}`,
                                value: index,
                              }))}
                              onChange={(index) => {
                                setMethodIndexes((current) => ({
                                  ...current,
                                  [provider.id]: index,
                                }));
                                setPromptValues((current) => ({
                                  ...current,
                                  [provider.id]: {},
                                }));
                              }}
                            />
                          )}
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
                        </>
                      )}
                      {oauthMethods.length > 1 && (
                        <Select
                          aria-label={`${provider.name} OAuth method`}
                          value={oauthMethodIndex}
                          options={oauthMethods.map((candidate, index) => ({
                            label: candidate.label,
                            value: index,
                          }))}
                          onChange={(index) => {
                            setOAuthMethodIndexes((current) => ({
                              ...current,
                              [provider.id]: index,
                            }));
                            setOAuthPromptValues((current) => ({
                              ...current,
                              [provider.id]: {},
                            }));
                          }}
                        />
                      )}
                      <AuthPromptFields
                        prompts={visibleOAuthPrompts}
                        values={oauthValues}
                        onChange={(key, value) =>
                          setOAuthPromptValues((current) => ({
                            ...current,
                            [provider.id]: { ...current[provider.id], [key]: value },
                          }))
                        }
                      />
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
