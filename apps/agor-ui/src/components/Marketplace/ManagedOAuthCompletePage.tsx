import type { AgorClient } from '@agor-live/client';
import { Alert, Flex, Typography, theme } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { completeManagedOAuthReturn, consumeManagedOAuthReturn } from './managedOAuthReturn';

export function ManagedOAuthCompletePage({
  client,
  userId,
  authorityKey,
}: {
  client: AgorClient | null;
  userId: string;
  authorityKey: string | null;
}) {
  const { token } = theme.useToken();
  const [status, setStatus] = useState<'pending' | 'ready' | 'failed'>('pending');
  const current = useRef({ client, userId, authorityKey });
  current.current = { client, userId, authorityKey };
  const [confirmedOwner, setConfirmedOwner] = useState<typeof current.current | null>(null);
  const displayedStatus =
    status === 'ready' &&
    (!authorityKey ||
      confirmedOwner?.client !== client ||
      confirmedOwner?.userId !== userId ||
      confirmedOwner?.authorityKey !== authorityKey)
      ? 'pending'
      : status;
  useEffect(() => {
    if (!client || !authorityKey) return;
    const controller = new AbortController();
    const isCurrent = () =>
      !controller.signal.aborted &&
      current.current.client === client &&
      current.current.userId === userId &&
      current.current.authorityKey === authorityKey;
    setStatus('pending');
    try {
      const returned = consumeManagedOAuthReturn(userId);
      void completeManagedOAuthReturn(client, returned, isCurrent, controller.signal)
        .then(() => {
          if (isCurrent()) {
            setConfirmedOwner({ client, userId, authorityKey });
            setStatus('ready');
          }
        })
        .catch(() => {
          if (isCurrent()) setStatus('failed');
        });
    } catch {
      setStatus('failed');
    }
    return () => controller.abort();
  }, [client, userId, authorityKey]);
  return (
    <Flex
      vertical
      gap={token.margin}
      style={{ maxWidth: 640, margin: `${token.marginXL}px auto`, padding: token.paddingLG }}
    >
      <Typography.Title level={2}>Agor-managed sign-in</Typography.Title>
      <Alert
        showIcon
        type={
          displayedStatus === 'ready' ? 'success' : displayedStatus === 'failed' ? 'error' : 'info'
        }
        title={
          displayedStatus === 'ready'
            ? 'Connected'
            : displayedStatus === 'failed'
              ? 'Sign-in could not be verified'
              : 'Verifying saved connection…'
        }
        description={
          displayedStatus === 'ready'
            ? "You can close this window. Existing session attachments are unchanged; choose this connection in each session's MCP menu."
            : displayedStatus === 'failed'
              ? 'Return to My Servers and start sign-in again. Your other connections are unchanged.'
              : 'Waiting for durable local completion. Returning from the provider is not confirmation.'
        }
      />
    </Flex>
  );
}
