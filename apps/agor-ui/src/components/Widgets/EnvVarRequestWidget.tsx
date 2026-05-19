/**
 * EnvVarRequestWidget — env_vars in-conversation widget UI.
 *
 * Renders inline in the transcript when an agent calls
 * `agor_widgets_request_env_vars`. Captures one or more secret values via
 * password inputs and POSTs them DIRECTLY to the daemon
 * (`POST /widgets/:widget_id/submit`) — values never flow through the agent's
 * MCP transport.
 *
 * Terminal states (read-only summaries):
 *   - submitted        ✅ names + scope + submitter timestamp
 *   - dismissed        ⊘ names + "request dismissed"
 *   - already_present  ✓ names + "already configured"
 *
 * See `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

import type { EnvVarScope, Message, WidgetMessageMetadata } from '@agor-live/client';
import {
  CheckCircleOutlined,
  LockOutlined,
  MinusCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Input, Radio, Space, Tag, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { getDaemonUrl } from '@/config/daemon';
import { useThemedMessage } from '@/utils/message';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { registerWidgetComponent, type WidgetComponentProps } from '../MessageBlock/WidgetBlock';

const { Text } = Typography;

interface EnvVarsParams {
  names: string[];
  reason: string;
  instructions?: string;
  default_scope: EnvVarScope;
  auto_resume?: boolean;
}

interface EnvVarsResultMeta {
  names_submitted: string[];
  scope: EnvVarScope;
}

function getAuthHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('feathers-jwt') : null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Coerce the widget's `params` (typed as `unknown` on the generic metadata) to
 * the env_vars-specific shape. The daemon validates with Zod before writing
 * the message row, so by the time this renders the shape is guaranteed.
 */
function readParams(widget: WidgetMessageMetadata): EnvVarsParams {
  return widget.params as EnvVarsParams;
}

function readResultMeta(widget: WidgetMessageMetadata): EnvVarsResultMeta | undefined {
  return widget.result_meta as EnvVarsResultMeta | undefined;
}

interface PendingFormProps {
  widgetId: string;
  message: Message;
  params: EnvVarsParams;
}

const PendingForm: React.FC<PendingFormProps> = ({ widgetId, message: _message, params }) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const name of params.names) initial[name] = '';
    return initial;
  });
  const [scope, setScope] = useState<EnvVarScope>(params.default_scope ?? 'global');
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allFilled = useMemo(
    () => params.names.every((name) => values[name]?.trim().length > 0),
    [params.names, values]
  );

  const post = async (path: 'submit' | 'dismiss', body: unknown) => {
    const url = `${getDaemonUrl()}/widgets/${encodeURIComponent(widgetId)}/${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(detail || `${res.statusText} (${res.status})`);
    }
    return res.json().catch(() => ({}));
  };

  const handleSubmit = async () => {
    if (!allFilled || submitting) return;
    setError(null);
    setSubmitting(true);
    // Build the submit payload from local state. Note: `values` never crosses
    // into the message metadata or the daemon-broadcast event — only into the
    // direct HTTP POST below.
    const submitBody = {
      values: Object.fromEntries(params.names.map((name) => [name, values[name]?.trim() ?? ''])),
      scope,
    };
    try {
      await post('submit', submitBody);
      showSuccess(
        `Saved ${params.names.length === 1 ? params.names[0] : `${params.names.length} variables`} (${scope})`
      );
      // Don't manually flip local state — the daemon broadcasts a
      // `widget:resolved` event that re-renders the row from the patched
      // message metadata.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showError(`Failed to save: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDismiss = async () => {
    if (dismissing) return;
    setError(null);
    setDismissing(true);
    try {
      await post('dismiss', {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showError(`Failed to dismiss: ${msg}`);
    } finally {
      setDismissing(false);
    }
  };

  return (
    <Card
      size="small"
      title={
        <Space>
          <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />
          <Text strong>
            {params.names.length === 1
              ? `Agent needs ${params.names[0]}`
              : `Agent needs ${params.names.length} environment variables`}
          </Text>
        </Space>
      }
      style={{ margin: `${token.sizeUnit * 1.5}px 0`, background: token.colorBgContainer }}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <MarkdownRenderer content={params.reason} compact />

        {params.instructions && (
          <Alert
            type="info"
            showIcon={false}
            description={<MarkdownRenderer content={params.instructions} compact />}
          />
        )}

        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          {params.names.map((name) => (
            <div key={name}>
              <Tag icon={<LockOutlined />} color="gold" style={{ marginBottom: 4 }}>
                <code>{name}</code>
              </Tag>
              <Input.Password
                value={values[name] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [name]: e.target.value }))}
                placeholder={`Enter value for ${name}`}
                disabled={submitting || dismissing}
                aria-label={`Value for ${name}`}
                autoComplete="off"
              />
            </div>
          ))}
        </Space>

        <Space orientation="vertical" size={4}>
          <Text strong style={{ fontSize: token.fontSizeSM }}>
            Scope
          </Text>
          <Radio.Group
            value={scope}
            onChange={(e) => setScope(e.target.value as EnvVarScope)}
            disabled={submitting || dismissing}
          >
            <Radio value="session">Session (only this session)</Radio>
            <Radio value="global">Global (every session you own)</Radio>
          </Radio.Group>
        </Space>

        <Alert
          type="warning"
          showIcon
          title={
            <Text style={{ fontSize: token.fontSizeSM }}>
              Type values here, never paste them into chat. Values are encrypted at rest and never
              sent to the agent — only the variable names are.
            </Text>
          }
        />

        {error && <Alert type="error" showIcon title={error} />}

        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button onClick={handleDismiss} loading={dismissing} disabled={submitting}>
            Dismiss
          </Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!allFilled || dismissing}
          >
            Save &amp; continue
          </Button>
        </Space>
      </Space>
    </Card>
  );
};

const SubmittedSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const rm = readResultMeta(widget);
  const names = rm?.names_submitted ?? readParams(widget).names;
  const scope = rm?.scope ?? readParams(widget).default_scope ?? 'global';
  return (
    <Card
      size="small"
      style={{
        margin: `${token.sizeUnit * 1.5}px 0`,
        background: token.colorBgContainer,
        borderLeft: `3px solid ${token.colorSuccess}`,
      }}
    >
      <Space>
        <CheckCircleOutlined style={{ color: token.colorSuccess }} />
        <Space orientation="vertical" size={0}>
          <Text strong>
            {names.length === 1 ? `${names[0]} saved` : `${names.length} variables saved`} ({scope})
          </Text>
          {widget.resolved_at && (
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Submitted at {new Date(widget.resolved_at).toLocaleString()}
            </Text>
          )}
        </Space>
      </Space>
    </Card>
  );
};

const DismissedSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const names = readParams(widget).names;
  return (
    <Card
      size="small"
      style={{
        margin: `${token.sizeUnit * 1.5}px 0`,
        background: token.colorBgContainer,
        borderLeft: `3px solid ${token.colorBorder}`,
      }}
    >
      <Space>
        <MinusCircleOutlined style={{ color: token.colorTextSecondary }} />
        <Text type="secondary">Request for {names.join(', ')} dismissed</Text>
      </Space>
    </Card>
  );
};

const AlreadyPresentSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const names = readParams(widget).names;
  return (
    <Card
      size="small"
      style={{
        margin: `${token.sizeUnit * 1.5}px 0`,
        background: token.colorBgContainer,
        borderLeft: `3px solid ${token.colorInfo}`,
      }}
    >
      <Space>
        <CheckCircleOutlined style={{ color: token.colorInfo }} />
        <Space orientation="vertical" size={0}>
          <Text strong>
            {names.length === 1
              ? `${names[0]} was already configured`
              : `${names.join(', ')} were already configured`}
          </Text>
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            No action needed — the agent has resumed.
          </Text>
        </Space>
      </Space>
    </Card>
  );
};

export const EnvVarRequestWidget: React.FC<WidgetComponentProps> = ({ message, widget }) => {
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
      return <PendingForm widgetId={widgetId} message={message} params={params} />;
  }
};

// Register on module load so `WidgetBlock` can dispatch to it. The
// registration is a side-effect of importing this file (via the
// `Widgets/index.ts` barrel imported from `MessageBlock.tsx`).
registerWidgetComponent('env_vars', EnvVarRequestWidget);

export const _EnvVarRequestWidgetForTests = {
  PendingForm,
  SubmittedSummary,
  DismissedSummary,
  AlreadyPresentSummary,
};

export type { EnvVarsParams, EnvVarsResultMeta };
