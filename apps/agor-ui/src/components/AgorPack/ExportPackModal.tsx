import {
  AGOR_PACK,
  AGOR_PACK_DEFAULT_SESSION_MODE,
  type AgorPackSessionMode,
} from '@agor/core/types';
import type { Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { DownloadOutlined, FileZipOutlined, LockOutlined } from '@ant-design/icons';
import { Button, Flex, Skeleton, Typography, theme } from 'antd';
import { useState } from 'react';
import { exportPack } from '../../utils/agorPack';
import { useThemedMessage } from '../../utils/message';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';
import { FlaggedSessionsCard } from './CheckReport';
import { PreflightError, usePackPreflight } from './ExportPackPanel';
import { checkFromPreflight, exportEstimate } from './packCheck';
import { fill, megabytes, PACK_COPY } from './packCopy';
import { SessionHistoryPicker } from './SessionHistoryPicker';

export interface ExportPackModalProps {
  open: boolean;
  teammate: Branch;
  onClose: () => void;
}

/** "Export Ada to a file" from the teammate menu: everything moves; choose session history. */
export const ExportPackModal: React.FC<ExportPackModalProps> = ({ open, teammate, onClose }) => {
  const { token } = theme.useToken();
  const { showError, showSuccess } = useThemedMessage();
  const name = getTeammateConfig(teammate)?.displayName ?? teammate.name;
  const [sessions, setSessions] = useState<AgorPackSessionMode>(AGOR_PACK_DEFAULT_SESSION_MODE);
  const [leaveOut, setLeaveOut] = useState(true);
  const [exporting, setExporting] = useState(false);
  const { preflight, error, retry } = usePackPreflight([teammate.branch_id]);
  const check = preflight ? checkFromPreflight(preflight, sessions, false, leaveOut) : null;
  const estimate = preflight ? exportEstimate(preflight, sessions, false) : null;
  const filename = `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'teammate'
  }${AGOR_PACK.extension}`;

  const handleDownload = async () => {
    // Never export without a completed check (its exclusions apply).
    if (!check) return;
    setExporting(true);
    try {
      const result = await exportPack({
        branch_ids: [teammate.branch_id],
        sessions,
        exclude_session_ids: leaveOut ? (check?.flagged ?? []).map((s) => s.session_id) : [],
      });
      showSuccess(fill(PACK_COPY.expToast, { file: result.filename }));
      onClose();
    } catch (reason) {
      showError(`Export failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <AdaptiveSettingsModal
      title={fill(PACK_COPY.expTitle, { name })}
      open={open}
      onCancel={onClose}
      width={520}
      destroyOnHidden
      footer={
        <Flex justify="flex-end" gap={8}>
          <Button onClick={onClose}>{PACK_COPY.cancel}</Button>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={exporting}
            disabled={preflight === null}
            onClick={handleDownload}
          >
            {PACK_COPY.expBtn}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap="middle">
        <div
          style={{
            padding: '10px 14px',
            borderRadius: token.borderRadiusLG,
            border: `1px solid ${token.colorPrimary}`,
            background: token.colorPrimaryBg,
          }}
        >
          <Typography.Text strong>{fill(PACK_COPY.expMove, { name })}</Typography.Text>
          <div>
            <Typography.Text type="secondary">{PACK_COPY.expMoveD}</Typography.Text>
          </div>
        </div>
        <SessionHistoryPicker
          value={sessions}
          onChange={setSessions}
          preflight={preflight}
          includeOthers={false}
        />
        {error ? (
          <PreflightError error={error} onRetry={retry} />
        ) : check ? (
          <FlaggedSessionsCard check={check} leaveOut={leaveOut} onLeaveOutChange={setLeaveOut} />
        ) : (
          <Skeleton active paragraph={{ rows: 1 }} />
        )}
        <Flex
          align="center"
          gap={8}
          style={{
            padding: '8px 12px',
            borderRadius: token.borderRadius,
            background: token.colorFillQuaternary,
          }}
        >
          <FileZipOutlined />
          <Typography.Text code>{filename}</Typography.Text>
          {estimate && (
            <Typography.Text type="secondary">About {megabytes(estimate.bytes)} MB</Typography.Text>
          )}
        </Flex>
        <Typography.Text type="secondary">
          <LockOutlined /> {PACK_COPY.expSecrets} {PACK_COPY.expReconnect}
        </Typography.Text>
      </Flex>
    </AdaptiveSettingsModal>
  );
};
