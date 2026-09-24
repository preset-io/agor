/**
 * `agor login` browser step.
 *
 * The CLI opens `/cli-login?name=agor-cli-<host>-<id>`. A signed-in user (or one
 * returned here by the normal launch flow) explicitly creates a personal API key
 * tagged `cli_login` for that machine, then pastes it into the waiting terminal.
 * The key is never created on page load: a link alone must not mint a
 * credential. Re-running `agor login` on the same machine replaces that
 * machine's previous CLI key server-side.
 */

import { type CreateUserApiKeyRequest, USER_API_KEYS_SERVICE_PATH } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { CopyOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Spin, Typography } from 'antd';
import { useLayoutEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '../hooks/useAuthorityOperationGuard';
import { copyToClipboard } from '../utils/clipboard';
import { useThemedMessage } from '../utils/message';
import { ActionPageShell } from './ActionPageShell';

/** Must match the name the CLI generates (`agor-cli-<host>-<id>`). */
const CLI_KEY_NAME = /^agor-cli-[a-z0-9][a-z0-9-]{0,80}$/;

type CliLoginState =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; rawKey: string; replaced: number }
  | { kind: 'failed'; message: string };

export function parseCliKeyName(value: string | null): string | null {
  return value && CLI_KEY_NAME.test(value) ? value : null;
}

export interface CLILoginPageProps {
  client: AgorClient | null;
  currentUserId?: string | null;
  currentUserEmail?: string | null;
}

export function CLILoginPage({ client, currentUserId, currentUserEmail }: CLILoginPageProps) {
  const [searchParams] = useSearchParams();
  const keyName = parseCliKeyName(searchParams.get('name'));
  const [state, setState] = useState<CliLoginState>({ kind: 'idle' });
  const { showSuccess, showError } = useThemedMessage();
  // The displayed key belongs to one caller and one machine name: a different
  // user or link erases it. Like PersonalApiKeysTab, a same-user reconnect keeps
  // a displayed key, but any client/auth-generation change discards in-flight
  // replies and releases the pending state.
  const identityKey = currentUserId && keyName ? `${currentUserId}:${keyName}` : null;
  const authority = useAuthenticatedAuthorityScope(client, identityKey);
  const operationGuard = useAuthorityOperationGuard(authority.operationScope);
  const canCreate = authority.operationScope !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: identityKey intentionally erases the displayed raw key
  useLayoutEffect(() => {
    setState({ kind: 'idle' });
  }, [identityKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: operationScope intentionally releases a pending create whose reply will be discarded
  useLayoutEffect(() => {
    setState((current) => (current.kind === 'creating' ? { kind: 'idle' } : current));
  }, [authority.operationScope]);

  const create = async () => {
    const operation = operationGuard.begin();
    if (!client || !keyName || !operation.isCurrent()) return;
    setState({ kind: 'creating' });
    try {
      const request: CreateUserApiKeyRequest = {
        name: keyName,
        source: 'cli_login',
        replace_previous: true,
      };
      const result = (await client.service(USER_API_KEYS_SERVICE_PATH).create(request)) as {
        rawKey: string;
        replaced?: number;
      };
      if (!operation.isCurrent()) return;
      setState({ kind: 'created', rawKey: result.rawKey, replaced: result.replaced ?? 0 });
    } catch (error) {
      if (!operation.isCurrent()) return;
      setState({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Could not create a CLI key',
      });
    }
  };

  const copy = async (text: string) => {
    if (await copyToClipboard(text)) showSuccess('Copied. Paste it into your terminal.');
    else showError('Copy failed. Select the key and copy it manually.');
  };

  const status = (() => {
    if (!client) return <Spin />;
    if (!keyName) {
      return (
        <Alert
          type="error"
          showIcon
          title="This link is incomplete"
          description="Run agor login again and open the link it prints."
        />
      );
    }
    if (state.kind === 'created') {
      return (
        <>
          <Alert
            type="success"
            showIcon
            title="Paste this key into your terminal"
            description={
              state.replaced > 0
                ? "It replaces this machine's previous CLI key. It will not be shown again."
                : 'It will not be shown again.'
            }
          />
          <Input.TextArea
            aria-label="CLI key"
            value={state.rawKey}
            readOnly
            autoSize={{ minRows: 2 }}
            style={{ fontFamily: 'monospace' }}
          />
        </>
      );
    }
    return (
      <>
        {state.kind === 'failed' && <Alert type="error" showIcon title={state.message} />}
        <Typography.Paragraph style={{ margin: 0 }}>
          A command-line session on <Typography.Text code>{keyName}</Typography.Text> is asking to
          act as you in this workspace. Only continue if you just ran{' '}
          <Typography.Text code>agor login</Typography.Text> yourself.
        </Typography.Paragraph>
      </>
    );
  })();

  const primaryAction =
    client && keyName ? (
      state.kind === 'created' ? (
        <Button
          type="primary"
          size="large"
          icon={<CopyOutlined />}
          onClick={() => copy(state.rawKey)}
        >
          Copy key
        </Button>
      ) : (
        <Button
          type="primary"
          size="large"
          loading={state.kind === 'creating'}
          disabled={!canCreate}
          onClick={create}
        >
          Create CLI key
        </Button>
      )
    ) : undefined;

  return (
    <ActionPageShell
      titleId="cli-login-title"
      title="Sign in to the Agor CLI"
      subtitle={currentUserEmail ? `Signed in as ${currentUserEmail}` : 'Agor command-line access'}
      status={status}
      primaryAction={primaryAction}
      footnote="The key acts as you in this workspace only. Revoke it any time in User settings → API tokens, or run agor logout on that machine."
    />
  );
}
