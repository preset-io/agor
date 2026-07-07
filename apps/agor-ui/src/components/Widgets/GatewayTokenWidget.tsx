/**
 * GatewayTokenWidget — gateway_token in-conversation widget UI.
 *
 * Renders inline in the transcript when an agent calls
 * `agor_widgets_request_gateway_token`. Captures a gateway channel's platform
 * credentials (Slack bot/app tokens, GitHub private key, Teams app password)
 * via masked inputs and submits them DIRECTLY to the daemon via the Feathers
 * client (`widgets/:widget_id/submit`) — values never flow through the agent's
 * MCP context. The daemon probes the credentials and enables the channel only
 * when the probe finds no hard credential failure.
 *
 * Setting a channel's tokens is admin-only; a non-admin viewer sees a
 * read-only notice instead of a form that would 403 on submit.
 *
 * Terminal states (one-line read-only summaries):
 *   - submitted (enabled)   ✅ Tokens saved / channel enabled
 *   - submitted (disabled)  ⚠️ test failed — channel left disabled
 *   - dismissed             ⊘ Token setup dismissed
 *
 * See `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

import type { AgorClient, WidgetMessageMetadata } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  LockOutlined,
  MinusCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Button, Card, Input, Space, Typography, theme } from 'antd';
import { useMemo, useRef, useState } from 'react';
import { useAuth } from '@/hooks';
import { useAgorStore } from '@/store/agorStore';
import { useThemedMessage } from '@/utils/message';
import { registerWidgetComponent, type WidgetComponentProps } from '../MessageBlock/WidgetBlock';

const { Text } = Typography;

interface GatewayTokenParams {
  gatewayChannelId: string;
  channelType: string;
  channelName: string;
  fields: string[];
  reason: string;
}

interface GatewayTokenResultMeta {
  channelId: string;
  channelName: string;
  channelType: string;
  fieldsSet: string[];
  enabled: boolean;
  /** Tokens saved but the channel type has no probe — left disabled, unverified. */
  unverified?: boolean;
  test: { ok: boolean; summary: string };
}

interface FieldPresentation {
  label: string;
  placeholder: string;
  hint?: string;
  /** Required value prefix — light client-side validation only. */
  prefix?: string;
  textarea?: boolean;
}

/**
 * Per-field display metadata. Keyed by sensitive config field name; the value
 * shapes the input's label, placeholder, and prefix hint. Slack tokens carry
 * `xoxb-`/`xapp-` prefixes we can validate client-side; PEM keys and app
 * passwords have no stable prefix to check.
 */
const FIELD_PRESENTATION: Record<string, FieldPresentation> = {
  bot_token: {
    label: 'Bot token',
    placeholder: 'xoxb-…',
    hint: 'Slack bot token, starts with xoxb-',
    prefix: 'xoxb-',
  },
  app_token: {
    label: 'App-level token',
    placeholder: 'xapp-…',
    hint: 'Slack app-level token for Socket Mode, starts with xapp-',
    prefix: 'xapp-',
  },
  private_key: {
    label: 'Private key',
    placeholder: '-----BEGIN PRIVATE KEY-----',
    hint: 'GitHub App private key (PEM)',
    textarea: true,
  },
  app_password: {
    label: 'App password',
    placeholder: 'Teams app password',
    hint: 'Microsoft Teams app password',
  },
  signing_secret: {
    label: 'Signing secret',
    placeholder: 'Signing secret',
  },
  webhook_secret: {
    label: 'Webhook secret',
    placeholder: 'Webhook secret',
  },
};

function presentationFor(field: string): FieldPresentation {
  return FIELD_PRESENTATION[field] ?? { label: field, placeholder: `Enter ${field}` };
}

function readParams(widget: WidgetMessageMetadata): GatewayTokenParams {
  return widget.params as GatewayTokenParams;
}

function readResultMeta(widget: WidgetMessageMetadata): GatewayTokenResultMeta | undefined {
  return widget.result_meta as GatewayTokenResultMeta | undefined;
}

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

interface FieldRowProps {
  field: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  disabled: boolean;
}

const FieldRow: React.FC<FieldRowProps> = ({ field, value, onChange, error, disabled }) => {
  const { token } = theme.useToken();
  const presentation = presentationFor(field);
  // Secure multi-line fields (GitHub PEM) start revealed for entry, then
  // collapse once a value is committed so the raw key is never persistently
  // displayed like the masked single-line secrets.
  const [revealed, setRevealed] = useState(true);
  const inputProps = {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(e.target.value),
    placeholder: presentation.placeholder,
    disabled,
    'aria-label': `Value for ${presentation.label}`,
    autoComplete: 'off',
    status: error ? ('error' as const) : undefined,
  };
  const hasValue = value.trim().length > 0;
  const collapsedSecret = presentation.textarea && hasValue && !revealed;
  const renderInput = () => {
    if (presentation.textarea) {
      if (collapsedSecret) {
        return (
          <Space
            style={{
              width: '100%',
              justifyContent: 'space-between',
              padding: `${token.paddingXXS}px ${token.paddingXS}px`,
              border: `1px solid ${token.colorBorder}`,
              borderRadius: token.borderRadius,
            }}
          >
            <Space size={6}>
              <LockOutlined style={{ color: token.colorTextSecondary }} />
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {presentation.label} provided
              </Text>
            </Space>
            <Button
              size="small"
              type="link"
              disabled={disabled}
              onClick={() => {
                onChange('');
                setRevealed(true);
              }}
            >
              Replace
            </Button>
          </Space>
        );
      }
      return (
        <Input.TextArea
          {...inputProps}
          rows={3}
          onChange={(e) => {
            const next = e.target.value;
            onChange(next);
            // Collapse to the locked "provided" state the instant a value
            // lands (typed or pasted) so the raw PEM is never displayed after
            // entry.
            if (next.trim().length > 0) setRevealed(false);
          }}
        />
      );
    }
    return <Input.Password {...inputProps} />;
  };
  return (
    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
      <Text
        strong
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: token.fontSizeSM,
        }}
      >
        <LockOutlined style={{ color: token.colorTextSecondary, marginInlineEnd: 8 }} />
        {presentation.label}
      </Text>
      {renderInput()}
      {presentation.hint && !collapsedSecret ? (
        <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {presentation.hint}
        </Text>
      ) : null}
      {error ? (
        <Text type="danger" style={{ fontSize: token.fontSizeSM }}>
          {error}
        </Text>
      ) : null}
    </Space>
  );
};

interface PendingFormProps {
  widgetId: string;
  params: GatewayTokenParams;
  client: AgorClient | null;
}

const PendingForm: React.FC<PendingFormProps> = ({ widgetId, params, client }) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const fields = useMemo(() => params.fields, [params.fields]);

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of fields) initial[field] = '';
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [localResolution, setLocalResolution] = useState<'submitted' | 'dismissed' | null>(null);
  const resolvingRef = useRef(false);

  // Resolve the current user's role from the CANONICAL store row (mirrors
  // App.tsx) rather than the SLIM auth user, which carries no `role`. Setting a
  // channel's tokens is admin-only, so a known non-admin sees a read-only
  // notice instead of a form the daemon's admin guard would reject.
  const { user } = useAuth();
  const role = useAgorStore((s) => (user ? s.userById.get(user.user_id)?.role : undefined));
  // Mirrors the daemon's `hasMinimumRole(ctx.submitterRole, ROLES.ADMIN)` guard
  // in `applySubmit` (admin + superadmin, plus legacy 'owner' via normalizeRole).
  const isAdmin = hasMinimumRole(role, ROLES.ADMIN);

  const allFilled = useMemo(
    () => fields.every((field) => values[field]?.trim().length > 0),
    [fields, values]
  );

  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field]?.trim() ?? '';
      if (!value) {
        errors[field] = 'Enter a value.';
        continue;
      }
      const prefix = presentationFor(field).prefix;
      if (prefix && !value.startsWith(prefix)) {
        errors[field] = `Expected a value starting with ${prefix}.`;
      }
    }
    return errors;
  };

  const post = async (path: 'submit' | 'dismiss', body: unknown) => {
    if (!client) {
      throw new Error('No client available — refresh and try again');
    }
    return client.service(`widgets/${encodeURIComponent(widgetId)}/${path}`).create(body ?? {});
  };

  const handleSubmit = async () => {
    if (resolvingRef.current || localResolution) return;
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setValidationMessage('Fix the highlighted fields before saving.');
      return;
    }
    resolvingRef.current = true;
    setSubmitting(true);
    setValidationMessage(null);
    setFieldErrors({});
    const tokens: Record<string, string> = {};
    for (const field of fields) tokens[field] = values[field]?.trim() ?? '';
    try {
      await post('submit', { tokens });
      setLocalResolution('submitted');
      showSuccess('Tokens submitted');
    } catch (err) {
      resolvingRef.current = false;
      const message = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
      setValidationMessage(`${message}. Check the tokens and try again.`);
      showError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDismiss = async () => {
    if (resolvingRef.current || localResolution) return;
    resolvingRef.current = true;
    setDismissing(true);
    setValidationMessage(null);
    setFieldErrors({});
    try {
      await post('dismiss', {});
      setLocalResolution('dismissed');
    } catch (err) {
      resolvingRef.current = false;
      const message = `Dismiss failed: ${err instanceof Error ? err.message : String(err)}`;
      setValidationMessage(`${message}. Try again.`);
      showError(message);
    } finally {
      setDismissing(false);
    }
  };

  if (localResolution === 'submitted') {
    return (
      <TerminalLine
        icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
        borderColor={token.colorSuccess}
        text={<Text>Tokens submitted for "{params.channelName}"</Text>}
      />
    );
  }

  if (localResolution === 'dismissed') {
    return (
      <TerminalLine
        icon={<MinusCircleOutlined style={{ color: token.colorTextSecondary }} />}
        borderColor={token.colorBorder}
        text={<Text type="secondary">Token setup for "{params.channelName}" dismissed</Text>}
      />
    );
  }

  // Fail OPEN: only hide the form when the role is KNOWN and is NOT admin.
  // While the role is still loading (undefined), render the form — the
  // daemon's `applySubmit` admin guard is the real enforcement, so a slow
  // store hydration must never hide the form from a genuine admin.
  if (role !== undefined && !isAdmin) {
    return (
      <TerminalLine
        icon={<SafetyCertificateOutlined style={{ color: token.colorWarning }} />}
        borderColor={token.colorWarning}
        text={
          <Text type="secondary">
            An admin must complete token setup for "{params.channelName}".
          </Text>
        }
      />
    );
  }

  return (
    <Card
      size="small"
      style={{ margin: `${token.sizeUnit * 1.5}px 0`, background: token.colorBgContainer }}
      styles={{ body: { padding: token.paddingSM } }}
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Space size="small" style={{ width: '100%' }}>
          <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />
          <Text strong>
            Securely provide {params.channelType} tokens for "{params.channelName}"
          </Text>
        </Space>

        {params.reason ? (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {params.reason}
          </Text>
        ) : null}

        {fields.map((field) => (
          <FieldRow
            key={field}
            field={field}
            value={values[field] ?? ''}
            error={fieldErrors[field]}
            disabled={submitting || dismissing}
            onChange={(next) => {
              setValidationMessage(null);
              setFieldErrors((prev) => ({ ...prev, [field]: '' }));
              setValues((prev) => ({ ...prev, [field]: next }));
            }}
          />
        ))}

        {validationMessage ? (
          <Text type="danger" style={{ fontSize: token.fontSizeSM }}>
            {validationMessage}
          </Text>
        ) : null}

        <Space style={{ width: '100%', justifyContent: 'flex-end' }} size="small">
          {/* Dismiss is the admin-only decline action, so only surface it to a
              known admin — never during the role-loading window (isAdmin is
              false until the role hydrates). The daemon enforces the same. */}
          {isAdmin ? (
            <Button size="small" onClick={handleDismiss} loading={dismissing} disabled={submitting}>
              Dismiss
            </Button>
          ) : null}
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
    </Card>
  );
};

const SubmittedSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const rm = readResultMeta(widget);
  const params = readParams(widget);
  const name = rm?.channelName || params.channelName;
  const enabled = rm?.enabled ?? false;
  const unverified = rm?.unverified ?? false;
  const summary = rm?.test?.summary;
  if (enabled) {
    return (
      <TerminalLine
        icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
        borderColor={token.colorSuccess}
        text={
          <Space orientation="vertical" size={0}>
            <Text>Tokens saved — "{name}" enabled</Text>
            {summary ? (
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                Connection test: {summary}
              </Text>
            ) : null}
          </Space>
        }
      />
    );
  }
  if (unverified) {
    return (
      <TerminalLine
        icon={<ExclamationCircleOutlined style={{ color: token.colorWarning }} />}
        borderColor={token.colorWarning}
        text={
          <Space orientation="vertical" size={0}>
            <Text>Tokens saved — "{name}" left disabled, unverified</Text>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Credentials can't be auto-verified yet; enable the channel manually once confirmed.
            </Text>
          </Space>
        }
      />
    );
  }
  return (
    <TerminalLine
      icon={<ExclamationCircleOutlined style={{ color: token.colorWarning }} />}
      borderColor={token.colorWarning}
      text={
        <Space orientation="vertical" size={0}>
          <Text>Test failed — "{name}" left disabled</Text>
          {summary ? (
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {summary}
            </Text>
          ) : null}
        </Space>
      }
    />
  );
};

const DismissedSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const name = readParams(widget).channelName;
  return (
    <TerminalLine
      icon={<MinusCircleOutlined style={{ color: token.colorTextSecondary }} />}
      borderColor={token.colorBorder}
      text={<Text type="secondary">Token setup for "{name}" dismissed</Text>}
    />
  );
};

export const GatewayTokenWidget: React.FC<WidgetComponentProps> = ({ widget, client }) => {
  const params = readParams(widget);
  const widgetId = widget.widget_id as unknown as string;

  switch (widget.status) {
    case 'submitted':
      return <SubmittedSummary widget={widget} />;
    case 'dismissed':
      return <DismissedSummary widget={widget} />;
    default:
      return <PendingForm widgetId={widgetId} params={params} client={client} />;
  }
};

// Side-effect: register with the WidgetBlock dispatcher on module load.
registerWidgetComponent('gateway_token', GatewayTokenWidget);

export const _GatewayTokenWidgetForTests = {
  PendingForm,
  SubmittedSummary,
  DismissedSummary,
};

export type { GatewayTokenParams, GatewayTokenResultMeta };
