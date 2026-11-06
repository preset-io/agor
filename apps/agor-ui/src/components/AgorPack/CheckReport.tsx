import {
  ApiOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
  ExportOutlined,
} from '@ant-design/icons';
import { Alert, Card, Flex, Popover, Switch, Typography, theme } from 'antd';
import { Tag } from '../Tag';
import type { PackCheck, PackCheckCounts } from './packCheck';
import { countLabel, fill, PACK_COPY } from './packCopy';

const ENVIRONMENT_DOCS = 'https://agor.live/guide/environment-configuration';

export interface CheckReportProps {
  check: PackCheck;
  mode: 'move' | 'import';
  /** "Leave these N out" (only shown when sessions were flagged). */
  leaveOut: boolean;
  onLeaveOutChange: (value: boolean) => void;
}

const COUNTS: Array<{ key: keyof PackCheckCounts; one: string; many: string }> = [
  { key: 'teammates', one: PACK_COPY.cntTeammate, many: PACK_COPY.cntTeammates },
  { key: 'boards', one: PACK_COPY.cntBoard, many: PACK_COPY.cntBoards },
  { key: 'artifacts', one: PACK_COPY.cntArtifacts, many: PACK_COPY.cntArtifacts },
  { key: 'docs', one: PACK_COPY.cntDocs, many: PACK_COPY.cntDocs },
  { key: 'schedules', one: PACK_COPY.cntSchedules, many: PACK_COPY.cntSchedules },
  { key: 'sessions', one: PACK_COPY.cntSessions, many: PACK_COPY.cntSessions },
];

/** "Check before moving/importing": what moves, what to reconnect, what won't work. */
export const CheckReport: React.FC<CheckReportProps> = ({
  check,
  mode,
  leaveOut,
  onLeaveOutChange,
}) => {
  const { token } = theme.useToken();
  const groupTitle = (icon: React.ReactNode, title: string) => (
    <Flex align="center" gap={8}>
      {icon}
      <span>{title}</span>
    </Flex>
  );

  return (
    <Flex vertical gap={12}>
      <Card
        size="small"
        title={groupTitle(
          <CheckCircleFilled style={{ color: token.colorSuccess }} />,
          mode === 'move' ? PACK_COPY.grpMoves : PACK_COPY.grpImports
        )}
      >
        <Flex gap={8} wrap>
          {COUNTS.map(({ key, one, many }) => (
            <div
              key={key}
              style={{
                flex: '1 1 72px',
                padding: '6px 8px',
                borderRadius: token.borderRadius,
                background: token.colorFillQuaternary,
              }}
            >
              <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
                {check.counts[key].toLocaleString()}
              </Typography.Text>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  {countLabel(check.counts[key], one, many)}
                </Typography.Text>
              </div>
            </div>
          ))}
        </Flex>
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
          {PACK_COPY.movesPlus}
        </Typography.Paragraph>
      </Card>

      {check.reconnect.length > 0 && (
        <Card
          size="small"
          title={groupTitle(
            <ApiOutlined />,
            mode === 'move' ? PACK_COPY.grpReconnect : PACK_COPY.grpReconnectImp
          )}
        >
          <Flex gap={6} wrap>
            {check.reconnect.map((label) => (
              <Tag key={label}>{label}</Tag>
            ))}
          </Flex>
          <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
            {mode === 'move' ? PACK_COPY.reconnectWhy : PACK_COPY.reconnectWhyImp}
          </Typography.Paragraph>
        </Card>
      )}

      {check.wont.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={PACK_COPY.grpWont}
          description={
            <Flex vertical gap={6}>
              {check.wont.map((blocker) => (
                <Flex key={`${blocker.teammate}:${blocker.kind}:${blocker.host}`} gap={8}>
                  <Tag>{blocker.teammate}</Tag>
                  <span>
                    {blocker.kind === 'docker'
                      ? fill(PACK_COPY.wontDocker, { name: blocker.teammate })
                      : fill(PACK_COPY.wontHost, {
                          name: blocker.teammate,
                          host: blocker.host ?? '',
                        })}{' '}
                    <Typography.Link href={ENVIRONMENT_DOCS} target="_blank" rel="noreferrer">
                      {blocker.kind === 'docker'
                        ? PACK_COPY.wontDockerLink
                        : PACK_COPY.wontHostLink}{' '}
                      <ExportOutlined />
                    </Typography.Link>
                  </span>
                </Flex>
              ))}
            </Flex>
          }
        />
      )}

      <FlaggedSessionsCard check={check} leaveOut={leaveOut} onLeaveOutChange={onLeaveOutChange} />
    </Flex>
  );
};

/** "May contain passwords" with its "Leave these N out" switch (nothing when none). */
export const FlaggedSessionsCard: React.FC<
  Pick<CheckReportProps, 'check' | 'leaveOut' | 'onLeaveOutChange'>
> = ({ check, leaveOut, onLeaveOutChange }) => {
  const { token } = theme.useToken();
  if (check.flaggedCount === 0) return null;
  const toggle = fill(PACK_COPY.lookToggle, { n: check.flaggedCount });
  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={8}>
          <ExclamationCircleFilled style={{ color: token.colorWarning }} />
          <span>{PACK_COPY.grpLook}</span>
        </Flex>
      }
      extra={
        <Flex align="center" gap={8}>
          <Switch size="small" checked={leaveOut} onChange={onLeaveOutChange} aria-label={toggle} />
          <Typography.Text type="secondary">{toggle}</Typography.Text>
        </Flex>
      }
    >
      <Typography.Text>
        {fill(PACK_COPY.lookKeys, { n: check.flaggedCount })}{' '}
        {check.flagged.length > 0 && (
          <Popover
            trigger="click"
            content={
              <Flex vertical gap={2} style={{ maxWidth: 320 }}>
                {check.flagged.map((session) => (
                  <Typography.Text key={session.session_id} ellipsis>
                    {session.title || session.session_id.slice(0, 8)}
                  </Typography.Text>
                ))}
              </Flex>
            }
          >
            <Typography.Link>{PACK_COPY.lookShow}</Typography.Link>
          </Popover>
        )}
      </Typography.Text>
    </Card>
  );
};
