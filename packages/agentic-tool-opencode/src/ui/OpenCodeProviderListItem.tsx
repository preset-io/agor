import type {
  OpenCodeOAuthAttempt,
  OpenCodeProviderAuthPrompt,
  OpenCodeProviderSettings,
} from '@agor/core/types';
import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Input,
  List,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';

const ACTIVE_OAUTH_PHASES = new Set(['authorizing', 'awaiting_callback', 'completing']);
const DEVICE_CODE_PATTERN = /[A-Z0-9]{4}-[A-Z0-9]{4,5}/;

export function isActiveOAuthAttempt(attempt?: OpenCodeOAuthAttempt): boolean {
  return Boolean(attempt && ACTIVE_OAUTH_PHASES.has(attempt.phase));
}

export function visibleAuthPrompts(
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

export function preferredOAuthMethodIndex(methods: Array<{ label: string }>): number {
  const headless = methods.findIndex((method) => /headless/i.test(method.label));
  return headless >= 0 ? headless : 0;
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

type Provider = OpenCodeProviderSettings['providers'][number];

export function OpenCodeProviderListItem({
  provider,
  copyText,
  selected,
  selectedMethodIndex,
  promptValues,
  apiKey,
  oauthCode,
  oauthAttempt,
  busy,
  onConnect,
  onConnectOAuth,
  onCancelOAuth,
  onDisconnect,
  onSubmitOAuthCode,
  onMethodChange,
  onPromptChange,
  onApiKeyChange,
  onOAuthCodeChange,
}: {
  provider: Provider;
  copyText: (text: string) => Promise<boolean>;
  selected: boolean;
  selectedMethodIndex?: number;
  promptValues: Record<string, string>;
  apiKey: string;
  oauthCode: string;
  oauthAttempt?: OpenCodeOAuthAttempt;
  busy: boolean;
  onConnect: () => void;
  onConnectOAuth: () => void;
  onCancelOAuth: () => void;
  onDisconnect: () => void;
  onSubmitOAuthCode: () => void;
  onMethodChange: (index: number) => void;
  onPromptChange: (key: string, value: string) => void;
  onApiKeyChange: (value: string) => void;
  onOAuthCodeChange: (value: string) => void;
}) {
  const [copiedAuthorizationCode, setCopiedAuthorizationCode] = useState<string>();
  const methodIndex =
    selected && selectedMethodIndex !== undefined
      ? selectedMethodIndex
      : preferredOAuthMethodIndex(provider.authMethods);
  const method = provider.authMethods[methodIndex];
  const apiKeyAvailable = method?.type === 'api' || !method;
  const values = selected ? promptValues : {};
  const prompts = visibleAuthPrompts(method?.prompts, values);
  const promptsComplete = prompts.every((prompt) => values[prompt.key]?.trim());
  const oauthMethod = method?.type === 'oauth' ? method : undefined;
  const oauthActive = isActiveOAuthAttempt(oauthAttempt);
  const authorizationCode =
    oauthAttempt?.authorization?.method === 'auto'
      ? oauthAttempt.authorization.instructions.match(DEVICE_CODE_PATTERN)?.[0]
      : undefined;

  const actions = [
    provider.credentialPresence === 'present' ? (
      <Popconfirm
        key="remove-credential"
        title={`Remove the saved credential for ${provider.name}?`}
        onConfirm={onDisconnect}
      >
        <Button danger loading={busy}>
          Remove
        </Button>
      </Popconfirm>
    ) : selected && apiKeyAvailable ? (
      <Button
        key="connect"
        type="primary"
        loading={busy}
        disabled={!apiKey.trim() || !promptsComplete}
        onClick={onConnect}
      >
        Connect
      </Button>
    ) : null,
    provider.credentialPresence !== 'present' && selected && oauthMethod && !oauthActive ? (
      <Button
        key="oauth-connect"
        loading={busy}
        disabled={!promptsComplete}
        onClick={onConnectOAuth}
      >
        Connect with {oauthMethod.label}
      </Button>
    ) : null,
    provider.credentialPresence !== 'present' && selected && oauthActive ? (
      <Button key="oauth-cancel" danger loading={busy} onClick={onCancelOAuth}>
        Cancel authorization
      </Button>
    ) : null,
  ].filter(Boolean);

  return (
    <List.Item actions={actions} style={{ alignItems: 'flex-end' }}>
      <List.Item.Meta
        title={
          <Space>
            <Typography.Text strong>{provider.name}</Typography.Text>
            {provider.runtimeAvailable && <Tag color="blue">Available in runtime</Tag>}
            {provider.credentialPresence === 'present' && <Tag color="green">Saved credential</Tag>}
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
                  Saved credential presence could not be determined. Removal is unavailable until
                  discovery can read the native credential store.
                </Typography.Text>
              ) : provider.runtimeAvailable ? (
                <Typography.Text type="secondary">
                  Available in the OpenCode runtime without a saved credential. Runtime availability
                  may be built in and does not imply removable credentials.
                </Typography.Text>
              ) : null}
              {selected && oauthActive && oauthAttempt?.authorization && (
                <Alert
                  type="info"
                  showIcon
                  title="Authorization in progress"
                  description={
                    <Space orientation="vertical">
                      <Space size="small">
                        <Typography.Text>{oauthAttempt.authorization.instructions}</Typography.Text>
                        {authorizationCode && (
                          <Tooltip
                            title={
                              copiedAuthorizationCode === authorizationCode ? 'Copied' : 'Copy code'
                            }
                          >
                            <Button
                              type="text"
                              size="small"
                              aria-label={
                                copiedAuthorizationCode === authorizationCode
                                  ? 'Authorization code copied'
                                  : 'Copy authorization code'
                              }
                              icon={
                                copiedAuthorizationCode === authorizationCode ? (
                                  <CheckOutlined />
                                ) : (
                                  <CopyOutlined />
                                )
                              }
                              onClick={() =>
                                void copyText(authorizationCode)
                                  .then((copied) => {
                                    if (copied) setCopiedAuthorizationCode(authorizationCode);
                                  })
                                  .catch(() => undefined)
                              }
                            />
                          </Tooltip>
                        )}
                      </Space>
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
                              value={oauthCode}
                              onChange={(event) => onOAuthCodeChange(event.target.value)}
                              onPressEnter={onSubmitOAuthCode}
                            />
                            <Button
                              loading={busy}
                              disabled={!oauthCode.trim()}
                              onClick={onSubmitOAuthCode}
                            >
                              Submit authorization code
                            </Button>
                          </Space.Compact>
                        )}
                    </Space>
                  }
                />
              )}
              {selected &&
                oauthAttempt &&
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
              {selected && provider.authMethods.length > 1 && !oauthActive && (
                <Select
                  aria-label={`${provider.name} authentication method`}
                  value={methodIndex}
                  options={provider.authMethods.map((candidate, index) => ({
                    label: candidate.label,
                    value: index,
                  }))}
                  onChange={onMethodChange}
                  style={{ width: '100%' }}
                />
              )}
              {selected && !oauthActive && (
                <AuthPromptFields prompts={prompts} values={values} onChange={onPromptChange} />
              )}
              {selected && apiKeyAvailable && !oauthActive && (
                <Input.Password
                  aria-label={`${provider.name} API key`}
                  autoComplete="new-password"
                  placeholder="API key"
                  value={apiKey}
                  onChange={(event) => onApiKeyChange(event.target.value)}
                  onPressEnter={onConnect}
                />
              )}
            </Space>
          )
        }
      />
    </List.Item>
  );
}
