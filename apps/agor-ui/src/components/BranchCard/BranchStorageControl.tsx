import type { AgorClient, Branch } from '@agor-live/client';
import { Button, Popconfirm, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useAuthConfig } from '../../hooks/useAuthConfig';
import { useThemedMessage } from '../../utils/message';

export function BranchStorageControl({
  branch,
  client,
}: {
  branch: Branch;
  client: AgorClient | null;
}) {
  const { featuresConfig } = useAuthConfig();
  const { showError } = useThemedMessage();
  const [pending, setPending] = useState(false);
  const state = branch.workspace_storage;
  const residency = state?.residency ?? 'warm';
  const canCool =
    featuresConfig?.branchStorage?.coldStorageEnabled === true && branch.storage_mode === 'clone';
  if (residency === 'warm' && !canCool) return null;
  const transition = residency === 'cooling' || residency === 'warming';
  const stage = state?.error
    ? 'Needs attention'
    : {
        packing: 'Packing and uploading',
        cleanup: 'Reclaiming local space',
        restoring: 'Downloading and verifying',
        publishing: 'Publishing verified workspace',
        stored: undefined,
        ready: undefined,
      }[state?.phase ?? 'ready'];
  const label =
    residency === 'cold'
      ? 'In cold storage'
      : residency === 'cooling'
        ? 'Moving to cold storage…'
        : residency === 'warming'
          ? 'Restoring workspace…'
          : undefined;
  const act = async (action: 'cool' | 'restore') => {
    if (!client) return;
    setPending(true);
    try {
      await client.service(`branches/${branch.branch_id}/storage`).create({ action });
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Workspace storage operation failed');
    } finally {
      setPending(false);
    }
  };
  return (
    <Space size="small" wrap>
      {label && (
        <Tooltip title={state?.error ?? state?.phase}>
          <Tag icon={transition && !state?.error ? <Spin size="small" /> : undefined}>
            🧊 {label}
          </Tag>
        </Tooltip>
      )}
      {stage && (
        <Typography.Text type={state?.error ? 'warning' : 'secondary'}>{stage}</Typography.Text>
      )}
      {(residency === 'cold' || state?.retryable) && (
        <Button
          size="small"
          loading={pending}
          disabled={!client}
          onClick={() => void act('restore')}
        >
          Restore
        </Button>
      )}
      {residency === 'warm' && canCool && (
        <Popconfirm
          title="Move workspace to cold storage?"
          description="Stop external editors and detached processes first. Closing a browser tab does not stop its Zellij shell."
          onConfirm={() => act('cool')}
          okText="Move to cold storage"
        >
          <Button size="small" loading={pending} disabled={!client}>
            🧊 Move to cold storage
          </Button>
        </Popconfirm>
      )}
    </Space>
  );
}
