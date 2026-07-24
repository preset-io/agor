import type { AgorClient, OpenCodeProviderSettings as Settings } from '@agor-live/client';
import { Alert, Button, Input, List, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

export function OpenCodeProviderSettings({ client }: { client: AgorClient }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [query, setQuery] = useState('');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [methodIndexes, setMethodIndexes] = useState<Record<string, number>>({});
  const [promptValues, setPromptValues] = useState<Record<string, Record<string, string>>>({});
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
    const visiblePrompts =
      method?.prompts?.filter((prompt) => {
        if (!prompt.when) return true;
        const matches = values[prompt.when.key] === prompt.when.value;
        return prompt.when.op === 'eq' ? matches : !matches;
      }) ?? [];
    if (visiblePrompts.some((prompt) => !values[prompt.key]?.trim())) return;
    const metadata = Object.fromEntries(
      visiblePrompts.map((prompt) => [prompt.key, values[prompt.key].trim()])
    );
    setBusyProvider(providerId);
    setError(undefined);
    try {
      setSettings(
        await client
          .service('opencode-auth')
          .create({ providerId, apiKey, ...(Object.keys(metadata).length ? { metadata } : {}) })
      );
      setKeys((current) => ({ ...current, [providerId]: '' }));
      setPromptValues((current) => ({ ...current, [providerId]: {} }));
    } catch {
      setError('OpenCode could not configure that provider.');
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
        Connect providers that expose native API-key configuration through the managed OpenCode
        runtime.
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
          const apiKeyAvailable = apiMethods.length > 0 || provider.authMethods.length === 0;
          const methodIndex = methodIndexes[provider.id] ?? 0;
          const method = apiMethods[methodIndex];
          const values = promptValues[provider.id] ?? {};
          const visiblePrompts =
            method?.prompts?.filter((prompt) => {
              if (!prompt.when) return true;
              const matches = values[prompt.when.key] === prompt.when.value;
              return prompt.when.op === 'eq' ? matches : !matches;
            }) ?? [];
          const promptsComplete = visiblePrompts.every((prompt) => values[prompt.key]?.trim());

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
                  ) : !apiKeyAvailable ? (
                    <Typography.Text type="secondary">
                      OpenCode exposes OAuth-only authentication for this provider. OAuth connection
                      is not available here yet.
                    </Typography.Text>
                  ) : (
                    <Space direction="vertical" style={{ width: '100%' }}>
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
                      {visiblePrompts.map((prompt) =>
                        prompt.type === 'select' ? (
                          <Select
                            key={prompt.key}
                            aria-label={prompt.message}
                            placeholder={prompt.message}
                            value={values[prompt.key]}
                            options={prompt.options}
                            onChange={(value) =>
                              setPromptValues((current) => ({
                                ...current,
                                [provider.id]: {
                                  ...current[provider.id],
                                  [prompt.key]: value,
                                },
                              }))
                            }
                          />
                        ) : (
                          <Input
                            key={prompt.key}
                            aria-label={prompt.message}
                            placeholder={prompt.placeholder ?? prompt.message}
                            value={values[prompt.key] ?? ''}
                            onChange={(event) =>
                              setPromptValues((current) => ({
                                ...current,
                                [provider.id]: {
                                  ...current[provider.id],
                                  [prompt.key]: event.target.value,
                                },
                              }))
                            }
                          />
                        )
                      )}
                      <Input.Password
                        aria-label={`${provider.name} API key`}
                        autoComplete="new-password"
                        placeholder="API key"
                        value={keys[provider.id] ?? ''}
                        onChange={(event) =>
                          setKeys((current) => ({ ...current, [provider.id]: event.target.value }))
                        }
                        onPressEnter={() => void connect(provider.id)}
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
