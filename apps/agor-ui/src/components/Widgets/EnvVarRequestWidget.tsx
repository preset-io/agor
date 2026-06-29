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
import { Button, Card, Checkbox, Input, Select, Space, Typography, theme } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import { registerWidgetComponent, type WidgetComponentProps } from '../MessageBlock/WidgetBlock';
import { Tag } from '../Tag';

const { Text } = Typography;

interface EnvVarsParams {
  names: string[];
  reason: string;
  variable_metadata?: Record<
    string,
    {
      description?: string;
      placeholder?: string;
      format_hint?: string;
      input_type?: 'password' | 'text' | 'textarea';
    }
  >;
  auto_resume?: boolean;
}

interface EnvVarsResultMeta {
  names_submitted: string[];
  names_used_existing?: string[];
  scope: EnvVarScope;
}

function readParams(widget: WidgetMessageMetadata): EnvVarsParams {
  return widget.params as EnvVarsParams;
}

function readResultMeta(widget: WidgetMessageMetadata): EnvVarsResultMeta | undefined {
  return widget.result_meta as EnvVarsResultMeta | undefined;
}

function orderedEnvVarNames(names: string[]): string[] {
  return [...names].sort();
}

interface EnvVarExistingStatus {
  set: true;
  scope: EnvVarScope;
  resource_id?: string | null;
}

function describeNames(names: string[]): string {
  const ordered = orderedEnvVarNames(names);
  return ordered.length === 1 ? ordered[0] : `${ordered.length} variables`;
}

function buildSubmittedSummaryText(input: {
  submitted?: string[];
  usedExisting?: string[];
  scope: EnvVarScope;
}): string {
  const submitted = orderedEnvVarNames(input.submitted ?? []);
  const usedExisting = orderedEnvVarNames(input.usedExisting ?? []);
  const parts = [
    submitted.length > 0 ? `Saved ${describeNames(submitted)} (${input.scope})` : '',
    usedExisting.length > 0 ? `Used existing ${describeNames(usedExisting)} (global)` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

interface VarRowProps {
  name: string;
  value: string;
  onChange: (next: string) => void;
  metadata?: NonNullable<EnvVarsParams['variable_metadata']>[string];
  existing?: EnvVarExistingStatus;
  useExisting: boolean;
  onUseExistingChange: (next: boolean) => void;
  error?: string;
  disabled: boolean;
}

const VarRow: React.FC<VarRowProps> = ({
  name,
  value,
  onChange,
  metadata,
  existing,
  useExisting,
  onUseExistingChange,
  error,
  disabled,
}) => {
  const { token } = theme.useToken();
  const inputType = metadata?.input_type ?? 'password';
  const placeholder = metadata?.placeholder ?? `Enter value for ${name}`;
  const inputDisabled = disabled || useExisting;
  const inputProps = {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(e.target.value),
    placeholder,
    disabled: inputDisabled,
    'aria-label': `Value for ${name}`,
    autoComplete: 'off',
    status: error ? ('error' as const) : undefined,
  };
  return (
    <div>
      <Space orientation="vertical" size={4} style={{ width: '100%' }}>
        <Space size="small" wrap>
          <Text
            strong
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: token.fontFamilyCode,
              fontSize: token.fontSizeSM,
            }}
          >
            <LockOutlined style={{ color: token.colorTextSecondary }} />
            {name}
          </Text>
          {existing?.set ? <Tag color="success">Set (encrypted)</Tag> : null}
          {existing?.scope ? (
            <Tag color={existing.scope === 'global' ? 'blue' : 'purple'}>{existing.scope}</Tag>
          ) : null}
        </Space>
        {metadata?.description ? (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {metadata.description}
          </Text>
        ) : null}
        {existing?.scope === 'global' ? (
          <Checkbox
            checked={useExisting}
            onChange={(e) => onUseExistingChange(e.target.checked)}
            disabled={disabled}
          >
            Use saved encrypted value
          </Checkbox>
        ) : existing?.scope === 'session' ? (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Session-scoped saved values must be selected in Session Settings; enter a value here to
            use it now.
          </Text>
        ) : null}
        {inputType === 'textarea' ? (
          <Input.TextArea {...inputProps} rows={3} />
        ) : inputType === 'text' ? (
          <Input {...inputProps} />
        ) : (
          <Input.Password {...inputProps} />
        )}
        {metadata?.format_hint ? (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {metadata.format_hint}
          </Text>
        ) : null}
        {error ? (
          <Text type="danger" style={{ fontSize: token.fontSizeSM }}>
            {error}
          </Text>
        ) : null}
      </Space>
    </div>
  );
};

interface PendingFormProps {
  widgetId: string;
  message: Message;
  params: EnvVarsParams;
  client: AgorClient | null;
}

const PendingForm: React.FC<PendingFormProps> = ({ widgetId, message, params, client }) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const orderedNames = useMemo(() => orderedEnvVarNames(params.names), [params.names]);
  const [existingByName, setExistingByName] = useState<Record<string, EnvVarExistingStatus>>({});

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const name of orderedNames) initial[name] = '';
    return initial;
  });
  // Scope is a user-only choice — agent doesn't get to suggest it. Default
  // to global because the most common case is "credential I'll need across
  // sessions" (API keys, tokens). User can downscope to Session if they
  // want a one-off.
  const [scope, setScope] = useState<EnvVarScope>('global');
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [useExisting, setUseExisting] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const name of orderedNames) initial[name] = false;
    return initial;
  });
  const [localResolution, setLocalResolution] = useState<
    | {
        kind: 'submitted';
        names: string[];
        scope: EnvVarScope;
        usedExisting?: string[];
        submitted?: string[];
      }
    | { kind: 'dismissed'; names: string[] }
    | null
  >(null);
  const resolvingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const loadExisting = async () => {
      if (!client) return;
      const session = (await client.service('sessions').get(message.session_id)) as {
        created_by?: string;
      };
      if (!session.created_by) return;
      const creator = (await client.service('users').get(session.created_by)) as {
        env_vars?: Record<string, EnvVarExistingStatus>;
      };
      const next: Record<string, EnvVarExistingStatus> = {};
      for (const name of orderedNames) {
        const existing = creator.env_vars?.[name];
        if (existing?.set) next[name] = existing;
      }
      if (!cancelled) setExistingByName(next);
    };

    loadExisting().catch(() => {
      if (!cancelled) setExistingByName({});
    });

    return () => {
      cancelled = true;
    };
  }, [client, message.session_id, orderedNames]);

  const allFilled = useMemo(
    () => orderedNames.every((name) => useExisting[name] || values[name]?.trim().length > 0),
    [orderedNames, useExisting, values]
  );
  const missingNames = useMemo(
    () => orderedNames.filter((name) => !useExisting[name] && !values[name]?.trim()),
    [orderedNames, useExisting, values]
  );

  // Use the Feathers client so the built-in 401 refresh/retry hook fires
  // on token expiry rather than a raw 401 surfacing as a save failure.
  const post = async (path: 'submit' | 'dismiss', body: unknown) => {
    if (!client) {
      throw new Error('No client available — refresh and try again');
    }
    return client.service(`widgets/${encodeURIComponent(widgetId)}/${path}`).create(body ?? {});
  };

  const extractFieldErrors = (err: unknown): Record<string, string> => {
    const data = (err as { data?: { field_errors?: unknown } } | undefined)?.data;
    const raw = data?.field_errors;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [name, message] of Object.entries(raw)) {
      if (typeof message === 'string') out[name] = message;
    }
    return out;
  };

  const handleSubmit = async () => {
    if (resolvingRef.current || localResolution) return;
    if (!allFilled) {
      setValidationMessage('Enter all requested values before saving.');
      setFieldErrors(
        Object.fromEntries(missingNames.map((name) => [name, 'Enter a value or use a saved one.']))
      );
      return;
    }
    resolvingRef.current = true;
    setSubmitting(true);
    setValidationMessage(null);
    setFieldErrors({});
    const useExistingNames = orderedNames.filter((name) => useExisting[name]);
    const valueNames = orderedNames.filter((name) => !useExisting[name]);
    const submitBody = {
      values: Object.fromEntries(valueNames.map((name) => [name, values[name]?.trim() ?? ''])),
      use_existing: useExistingNames,
      scope,
    };
    try {
      await post('submit', submitBody);
      setLocalResolution({
        kind: 'submitted',
        names: orderedNames,
        scope,
        submitted: valueNames,
        usedExisting: useExistingNames,
      });
      showSuccess(
        buildSubmittedSummaryText({
          submitted: valueNames,
          usedExisting: useExistingNames,
          scope,
        })
      );
    } catch (err) {
      resolvingRef.current = false;
      const message = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
      setFieldErrors(extractFieldErrors(err));
      setValidationMessage(`${message}. Check the requested names and try again.`);
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
      setLocalResolution({ kind: 'dismissed', names: orderedNames });
    } catch (err) {
      resolvingRef.current = false;
      const message = `Dismiss failed: ${err instanceof Error ? err.message : String(err)}`;
      setValidationMessage(`${message}. Try again.`);
      showError(message);
    } finally {
      setDismissing(false);
    }
  };

  const title =
    orderedNames.length === 1
      ? 'Securely provide environment variable'
      : `Securely provide ${orderedNames.length} environment variables`;

  if (localResolution?.kind === 'submitted') {
    return (
      <TerminalLine
        icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
        borderColor={token.colorSuccess}
        text={
          <Space orientation="vertical" size={0}>
            <Text>{buildSubmittedSummaryText(localResolution)}</Text>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Need to correct one? Update it in User Settings → Env vars.
            </Text>
          </Space>
        }
      />
    );
  }

  if (localResolution?.kind === 'dismissed') {
    return (
      <TerminalLine
        icon={<MinusCircleOutlined style={{ color: token.colorTextSecondary }} />}
        borderColor={token.colorBorder}
        text={<Text type="secondary">{localResolution.names.join(', ')} dismissed</Text>}
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
          <Text strong>{title}</Text>
        </Space>

        {params.reason && (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {params.reason}
          </Text>
        )}

        {orderedNames.map((name) => (
          <VarRow
            key={name}
            name={name}
            value={values[name] ?? ''}
            metadata={params.variable_metadata?.[name]}
            existing={existingByName[name]}
            useExisting={!!useExisting[name]}
            onUseExistingChange={(next) => {
              setValidationMessage(null);
              setFieldErrors((prev) => ({ ...prev, [name]: '' }));
              setUseExisting((prev) => ({ ...prev, [name]: next }));
            }}
            onChange={(next) => {
              setValidationMessage(null);
              setFieldErrors((prev) => ({ ...prev, [name]: '' }));
              setValues((prev) => ({ ...prev, [name]: next }));
            }}
            error={fieldErrors[name]}
            disabled={submitting || dismissing}
          />
        ))}

        {validationMessage ? (
          <Text type="danger" style={{ fontSize: token.fontSizeSM }}>
            {validationMessage}
          </Text>
        ) : missingNames.length > 0 ? (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Enter {missingNames.length === 1 ? missingNames[0] : 'all requested values'} to save.
          </Text>
        ) : null}

        <Space style={{ width: '100%', justifyContent: 'space-between' }} size="small">
          <Space size="small">
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Scope for new values:
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
  const params = readParams(widget);
  const names = orderedEnvVarNames([
    ...(rm?.names_submitted ?? []),
    ...(rm?.names_used_existing ?? []),
  ]);
  const displayNames = names.length > 0 ? names : orderedEnvVarNames(params.names);
  const scope = rm?.scope ?? 'global';
  const summaryText = rm
    ? buildSubmittedSummaryText({
        submitted: rm.names_submitted,
        usedExisting: rm.names_used_existing,
        scope,
      })
    : `Saved ${describeNames(displayNames)} (${scope})`;
  return (
    <TerminalLine
      icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
      borderColor={token.colorSuccess}
      text={
        <Space orientation="vertical" size={0}>
          <Text>{summaryText}</Text>
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Need to correct one? Update it in User Settings → Env vars.
          </Text>
        </Space>
      }
    />
  );
};

const DismissedSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const names = orderedEnvVarNames(readParams(widget).names);
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
  const names = orderedEnvVarNames(readParams(widget).names);
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
