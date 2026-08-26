import type { AgorClient, CodexAuthImportResult } from '@agor-live/client';
import { Alert, Button, Input, Space, Typography, theme } from 'antd';
import { memo, useCallback, useLayoutEffect, useState } from 'react';
import { useAuthorityOperationGuard } from '../../hooks/useAuthorityOperationGuard';

const { Text } = Typography;
const { useToken } = theme;

export interface CodexImportAuthJsonProps {
  client: AgorClient | null;
  /**
   * Fired after the daemon accepts the pasted login and persists it. The pasted
   * token material is already dropped from this component's state by the time
   * this runs — the surface follows up (advance a step, re-probe status) without
   * ever holding the secret itself.
   */
  onImported: (result: CodexAuthImportResult) => void;
  /** Label for the submit action; surfaces frame it differently. */
  submitLabel?: string;
  /** Identity-only key: changes erase the caller-private pasted credential. */
  identityKey?: string | null;
  /** Generation/connection scope: changes cancel work but preserve the draft. */
  operationScope?: readonly unknown[] | null;
}

/**
 * Self-contained pane for pasting a `~/.codex/auth.json` login file and handing
 * it to the daemon. Owns its own paste value, submit, and error state so a
 * rejected import never leaks into the hosting surface's form state, and so the
 * secret is cleared from memory the moment the daemon confirms it landed.
 */
export const CodexImportAuthJson = memo(function CodexImportAuthJson({
  client,
  onImported,
  submitLabel = 'Import login',
  identityKey,
  operationScope,
}: CodexImportAuthJsonProps) {
  const { token } = useToken();
  const [authJson, setAuthJson] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Identity and operation lifetime are intentionally separate. Reconnecting
  // the same caller invalidates an in-flight request but keeps their pasted
  // draft; replacing the caller erases it synchronously during layout commit.
  const effectiveOperationScope =
    operationScope === undefined ? ([client] as const) : operationScope;
  const operationAvailable = effectiveOperationScope !== null;
  const operationGuard = useAuthorityOperationGuard(effectiveOperationScope);
  const effectiveIdentityKey = identityKey === undefined ? client : identityKey;

  // biome-ignore lint/correctness/useExhaustiveDependencies: effectiveIdentityKey intentionally owns secret-draft erasure, independently of auth generation
  useLayoutEffect(() => {
    setAuthJson('');
    setError(null);
    setSubmitting(false);
  }, [effectiveIdentityKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new operation epoch releases the obsolete request's UI lock without erasing the same caller's draft
  useLayoutEffect(() => {
    setSubmitting(false);
  }, [operationGuard]);

  const handleImport = useCallback(async () => {
    if (!client || !authJson.trim() || submitting || !operationAvailable) return;
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
    const submittedAuthJson = authJson;
    setSubmitting(true);
    setError(null);
    try {
      const result = (await client
        .service('codex-auth/import')
        .create({ authJson: submittedAuthJson })) as CodexAuthImportResult;
      if (!operation.isCurrent()) return;
      // Drop the pasted token material as soon as the daemon has it — nothing
      // here needs it after a successful import.
      setAuthJson('');
      onImported(result);
    } catch (err) {
      if (!operation.isCurrent()) return;
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not import the Codex login — try again.'
      );
    } finally {
      if (operation.isCurrent()) setSubmitting(false);
    }
  }, [authJson, client, onImported, operationAvailable, operationGuard, submitting]);

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        style={{ fontSize: token.fontSizeSM }}
        message={
          <span>
            Already use Codex on your own machine? Its credential file lives there at{' '}
            <Text code>~/.codex/auth.json</Text>. On that machine, print it with{' '}
            <Text code>cat ~/.codex/auth.json</Text> and paste the whole thing below — this replaces
            the Codex login already stored on this server, which in shared setups is one login for
            the whole server, not one per person. Or skip the copy-paste entirely: open a branch
            terminal on this server and run <Text code>codex login --device-auth</Text>.
          </span>
        }
      />
      <Input.Password
        aria-label="Codex auth.json contents"
        placeholder="Paste the JSON from ~/.codex/auth.json…"
        value={authJson}
        onChange={(e) => {
          setAuthJson(e.target.value);
          setError(null);
        }}
        onPressEnter={handleImport}
        style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}
      />
      <Button
        type="primary"
        loading={submitting}
        disabled={!client || !authJson.trim() || !operationAvailable}
        onClick={handleImport}
      >
        {submitLabel}
      </Button>
      {error && (
        <Alert type="error" showIcon message={error} style={{ fontSize: token.fontSizeSM }} />
      )}
    </Space>
  );
});
