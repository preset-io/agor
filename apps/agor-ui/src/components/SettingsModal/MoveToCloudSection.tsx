import type { AgorCloudLinkStatus, AgorCloudMove, AgorPackSwitchOverState } from '@agor/core/types';
import type { User } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { CheckCircleFilled, CloudOutlined, CloudUploadOutlined } from '@ant-design/icons';
import { Button, Flex, Progress, Typography, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  disconnectCloudLink,
  fetchPackPreflight,
  getCloudLink,
  getLatestCloudMove,
} from '../../utils/agorPack';
import {
  MoveToCloudModal,
  movePercent,
  peekCloudReturn,
  SwitchOverControl,
  useMovableTeammates,
} from '../AgorPack/MoveToCloudModal';
import { PACK_COPY } from '../AgorPack/packCopy';
import { Tag } from '../Tag';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';

export interface MoveToCloudSectionProps {
  currentUser?: User | null;
}

/**
 * Settings → System → Agor Cloud (self-hosted only): what Agor Cloud gives
 * you and one button that opens the Move modal. Members move their own
 * teammates; admins can move anyone's. After a move, each moved teammate can
 * be switched over here (its schedules and channels paused) or switched back.
 */
export const MoveToCloudSection: React.FC<MoveToCloudSectionProps> = ({ currentUser }) => {
  const { token } = theme.useToken();
  const teammates = useMovableTeammates(currentUser);
  // A sign-in coming back from the console opens the modal to confirm it.
  const [open, setOpen] = useState(() => Boolean(peekCloudReturn()));
  const [cloud, setCloud] = useState<AgorCloudLinkStatus | null>(null);
  const [move, setMove] = useState<AgorCloudMove | null>(null);
  const [switchState, setSwitchState] = useState<Record<string, AgorPackSwitchOverState | null>>(
    {}
  );

  // Refresh the link and the latest move whenever the modal closes.
  useEffect(() => {
    if (open) return;
    let cancelled = false;
    getCloudLink()
      .then((status) => !cancelled && setCloud(status))
      .catch(() => undefined);
    getLatestCloudMove()
      .then((latest) => !cancelled && setMove(latest))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const moved = useMemo(() => move?.items.filter((item) => item.status === 'done') ?? [], [move]);
  const movedKey = moved.map((item) => item.branch_id).join(',');
  useEffect(() => {
    if (!movedKey) return;
    let cancelled = false;
    fetchPackPreflight(movedKey.split(','))
      .then(
        (rows) =>
          !cancelled &&
          setSwitchState(Object.fromEntries(rows.map((row) => [row.branch_id, row.switch_over])))
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [movedKey]);

  const link = cloud?.link;
  const host = link ? new URL(link.workspace_url).host : null;

  return (
    <div>
      <ResponsiveSettingsHeader title={PACK_COPY.cloudNav} />
      <Flex vertical gap="middle" style={{ maxWidth: 680 }}>
        <Flex
          vertical
          gap={14}
          style={{
            padding: 20,
            borderRadius: token.borderRadiusLG,
            border: `1px solid ${token.colorPrimaryBorder}`,
            background: `linear-gradient(135deg, ${token.colorPrimaryBg}, ${token.colorBgContainer})`,
          }}
        >
          <Flex align="center" gap={12}>
            <Flex
              align="center"
              justify="center"
              style={{
                width: 36,
                height: 36,
                flexShrink: 0,
                borderRadius: token.borderRadiusLG,
                background: token.colorPrimary,
                color: token.colorTextLightSolid,
                fontSize: 18,
              }}
            >
              <CloudOutlined />
            </Flex>
            <Flex vertical>
              <Typography.Title level={4} style={{ margin: 0 }}>
                {PACK_COPY.cloudTitle}
              </Typography.Title>
              <Typography.Text type="secondary">{PACK_COPY.cloudLead}</Typography.Text>
            </Flex>
          </Flex>
          <Flex vertical gap={6}>
            {[PACK_COPY.cloudP1, PACK_COPY.cloudP2, PACK_COPY.cloudP3].map((point) => (
              <Flex key={point} align="center" gap={8}>
                <CheckCircleFilled style={{ color: token.colorPrimary }} />
                <Typography.Text>{point}</Typography.Text>
              </Flex>
            ))}
          </Flex>
          <Flex vertical gap={6}>
            {teammates.length > 0 && (
              <Flex gap={6} wrap>
                {teammates.map((branch) => (
                  <Tag key={branch.branch_id} style={{ marginInlineEnd: 0 }}>
                    {getTeammateConfig(branch)?.emoji ?? '🤖'}{' '}
                    {getTeammateConfig(branch)?.displayName ?? branch.name}
                  </Tag>
                ))}
              </Flex>
            )}
            <Typography.Text type="secondary">{PACK_COPY.cloudComes}</Typography.Text>
          </Flex>
          <Flex align="center" gap={12} wrap>
            <Button
              type="primary"
              icon={<CloudUploadOutlined />}
              disabled={teammates.length === 0}
              onClick={() => setOpen(true)}
            >
              {PACK_COPY.cloudBtn}
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {PACK_COPY.cloudSafe}
            </Typography.Text>
          </Flex>
        </Flex>

        {move?.status === 'moving' && (
          <Flex
            align="center"
            gap={12}
            style={{
              padding: '10px 14px',
              borderRadius: token.borderRadiusLG,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <Typography.Link onClick={() => setOpen(true)}>{PACK_COPY.progTitle}</Typography.Link>
            <Progress
              percent={movePercent(move)}
              size="small"
              status="active"
              style={{ flex: 1, margin: 0 }}
            />
          </Flex>
        )}

        {moved.length > 0 && (
          <Flex
            vertical
            gap={8}
            style={{
              padding: '10px 14px',
              borderRadius: token.borderRadiusLG,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <Typography.Text type="secondary">{PACK_COPY.doneNext}</Typography.Text>
            {moved.map((item) => (
              <Flex key={item.branch_id} align="center" justify="space-between" gap={8}>
                <Typography.Text>
                  {item.emoji ?? '🤖'} {item.display_name}{' '}
                  {item.open_url && (
                    <Typography.Link href={item.open_url} target="_blank" rel="noopener noreferrer">
                      {PACK_COPY.doneOpen}
                    </Typography.Link>
                  )}
                </Typography.Text>
                <SwitchOverControl
                  branchId={item.branch_id}
                  state={switchState[item.branch_id]}
                  onChange={(state) =>
                    setSwitchState((prev) => ({ ...prev, [item.branch_id]: state }))
                  }
                />
              </Flex>
            ))}
          </Flex>
        )}

        {link && (
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Signed in to {link.workspace_display_name ?? host}
            {link.cloud_email ? ` as ${link.cloud_email}` : ''}. This install forgets the sign-in
            after 7 days unused.{' '}
            <Typography.Link
              style={{ fontSize: token.fontSizeSM }}
              onClick={() => {
                disconnectCloudLink()
                  .then(setCloud)
                  .catch(() => undefined);
              }}
            >
              Disconnect
            </Typography.Link>
          </Typography.Text>
        )}
      </Flex>

      {open && (
        <MoveToCloudModal
          open
          currentUser={currentUser}
          onClose={() => setOpen(false)}
          onMoveChange={setMove}
        />
      )}
    </div>
  );
};
