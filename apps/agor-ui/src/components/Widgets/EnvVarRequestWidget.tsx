/**
 * EnvVarRequestWidget — env_vars in-conversation widget UI.
 *
 * Renders inline in the transcript when an agent calls
 * `agor_widgets_request_env_vars`. Captures secret value(s) via password
 * inputs and submits them DIRECTLY to the daemon via the Feathers client
 * (`widgets/:widget_id/submit`) — values never flow through the
 * agent's MCP transport.
 *
 * Design intent: KISS. Single card, no title bar, no warning Alert, no
 * instructions Alert. Lock icon + var name is the only mandatory chrome.
 *
 * Terminal states (one-line read-only summaries):
 *   - submitted        ✅ NAME saved (scope)
 *   - dismissed        ⊘ NAME dismissed
 *   - already_present  ✓ NAME already configured
 *
 * See `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

import type { AgorClient, EnvVarScope, Message, WidgetMessageMetadata } from '@agor-live/client';
import {
  CheckCircleOutlined,
  LockOutlined,
  MinusCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Button, Card, Input, Select, Space, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import { registerWidgetComponent, type WidgetComponentProps } from '../MessageBlock/WidgetBlock';

const { Text } = Typography;

interface EnvVarsParams {
  names: string[];
  reason: string;
  auto_resume?: boolean;
}

interface EnvVarsResultMeta {
  names_submitted: string[];
  scope: EnvVarScope;
}

function readParams(widget: WidgetMessageMetadata): EnvVarsParams {
  return widget.params as EnvVarsParams;
}

function readResultMeta(widget: WidgetMessageMetadata): EnvVarsResultMeta | undefined {
  return widget.result_meta as EnvVarsResultMeta | undefined;
}

interface VarRowProps {
  name: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}

const VarRow: React.FC<VarRowProps> = ({ name, value, onChange, disabled }) => {
  const { token } = theme.useToken();
  return (
    <div>
      <Text
        strong
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 4,
          fontFamily: token.fontFamilyCode,
          fontSize: token.fontSizeSM,
        }}
      >
        <LockOutlined style={{ color: token.colorTextSecondary }} />
        {name}
      </Text>
      <Input.Password
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Enter value for ${name}`}
        disabled={disabled}
        aria-label={`Value for ${name}`}
        autoComplete="off"
      />
    </div>
  );
};

interface PendingFormProps {
  widgetId: string;
  message: Message;
  params: EnvVarsParams;
  client: AgorClient | null;
}

const PendingForm: React.FC<PendingFormProps> = ({
  widgetId,
  message: _message,
  params,
  client,
}) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const name of params.names) initial[name] = '';
    return initial;
  });
  // Scope is a user-only choice — agent doesn't get to suggest it. Default
  // to global because the most common case is "credential I'll need across
  // sessions" (API keys, tokens). User can downscope to Session if they
  // want a one-off.
  const [scope, setScope] = useState<EnvVarScope>('global');
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const allFilled = useMemo(
    () => params.names.every((name) => values[name]?.trim().length > 0),
    [params.names, values]
  );

  // Use the Feathers client so the built-in 401 refresh/retry hook fires
  // on token expiry rather than a raw 401 surfacing as a save failure.
  const post = async (path: 'submit' | 'dismiss', body: unknown) => {
    if (!client) {
      throw new Error('No client available — refresh and try again');
    }
    return client.service(`widgets/${encodeURIComponent(widgetId)}/${path}`).create(body ?? {});
  };

  const handleSubmit = async () => {
    if (!allFilled || submitting) return;
    setSubmitting(true);
    const submitBody = {
      values: Object.fromEntries(params.names.map((name) => [name, values[name]?.trim() ?? ''])),
      scope,
    };
    try {
      await post('submit', submitBody);
      showSuccess(
        params.names.length === 1
          ? `Saved ${params.names[0]} (${scope})`
          : `Saved ${params.names.length} variables (${scope})`
      );
    } catch (err) {
      showError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDismiss = async () => {
    if (dismissing) return;
    setDismissing(true);
    try {
      await post('dismiss', {});
    } catch (err) {
      showError(`Dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDismissing(false);
    }
  };

  const title =
    params.names.length === 1
      ? 'Securely provide environment variable'
      : `Securely provide ${params.names.length} environment variables`;

  return (
    <Card
      size="small"
      style={{ margin: `${token.sizeUnit * 1.5}px 0`, background: token.colorBgContainer }}
      styles={{ body: { padding: token.paddingSM } }}
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Space size="small" style={{ width: '100%' }}>
          <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />
          <Text strong>{title}</Text>
        </Space>

        {params.reason && (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {params.reason}
          </Text>
        )}

        {params.names.map((name) => (
          <VarRow
            key={name}
            name={name}
            value={values[name] ?? ''}
            onChange={(next) => setValues((prev) => ({ ...prev, [name]: next }))}
            disabled={submitting || dismissing}
          />
        ))}

        <Space style={{ width: '100%', justifyContent: 'space-between' }} size="small">
          <Space size="small">
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Scope:
            </Text>
            <Select
              size="small"
              value={scope}
              onChange={(v) => setScope(v)}
              disabled={submitting || dismissing}
              style={{ width: 110 }}
              options={[
                { value: 'global', label: 'Global' },
                { value: 'session', label: 'Session' },
              ]}
            />
          </Space>
          <Space size="small">
            <Button size="small" onClick={handleDismiss} loading={dismissing} disabled={submitting}>
              Dismiss
            </Button>
            <Button
              size="small"
              type="primary"
              onClick={handleSubmit}
              loading={submitting}
              disabled={!allFilled || dismissing}
            >
              Save
            </Button>
          </Space>
        </Space>
      </Space>
    </Card>
  );
};

const TerminalLine: React.FC<{
  icon: React.ReactNode;
  borderColor: string;
  text: React.ReactNode;
}> = ({ icon, borderColor, text }) => {
  const { token } = theme.useToken();
  return (
    <Card
      size="small"
      style={{
        margin: `${token.sizeUnit * 1.5}px 0`,
        background: token.colorBgContainer,
        borderLeft: `3px solid ${borderColor}`,
      }}
      styles={{ body: { padding: `${token.paddingXS}px ${token.paddingSM}px` } }}
    >
      <Space size="small">
        {icon}
        {text}
      </Space>
    </Card>
  );
};

const SubmittedSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const rm = readResultMeta(widget);
  const names = rm?.names_submitted ?? readParams(widget).names;
  const scope = rm?.scope ?? 'global';
  return (
    <TerminalLine
      icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
      borderColor={token.colorSuccess}
      text={
        <Text>
          {names.length === 1 ? names[0] : `${names.length} variables`} saved
          <Text type="secondary"> ({scope})</Text>
        </Text>
      }
    />
  );
};

const DismissedSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const names = readParams(widget).names;
  return (
    <TerminalLine
      icon={<MinusCircleOutlined style={{ color: token.colorTextSecondary }} />}
      borderColor={token.colorBorder}
      text={<Text type="secondary">{names.join(', ')} dismissed</Text>}
    />
  );
};

const AlreadyPresentSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const names = readParams(widget).names;
  return (
    <TerminalLine
      icon={<CheckCircleOutlined style={{ color: token.colorInfo }} />}
      borderColor={token.colorInfo}
      text={
        <Text>
          {names.length === 1 ? names[0] : names.join(', ')}{' '}
          <Text type="secondary">already configured</Text>
        </Text>
      }
    />
  );
};

export const EnvVarRequestWidget: React.FC<WidgetComponentProps> = ({
  message,
  widget,
  client,
}) => {
  const params = readParams(widget);
  const widgetId = widget.widget_id as unknown as string;

  switch (widget.status) {
    case 'submitted':
      return <SubmittedSummary widget={widget} />;
    case 'dismissed':
      return <DismissedSummary widget={widget} />;
    case 'already_present':
      return <AlreadyPresentSummary widget={widget} />;
    default:
      return <PendingForm widgetId={widgetId} message={message} params={params} client={client} />;
  }
};

// Side-effect: register with the WidgetBlock dispatcher on module load.
registerWidgetComponent('env_vars', EnvVarRequestWidget);

export const _EnvVarRequestWidgetForTests = {
  PendingForm,
  SubmittedSummary,
  DismissedSummary,
  AlreadyPresentSummary,
};

export type { EnvVarsParams, EnvVarsResultMeta };
