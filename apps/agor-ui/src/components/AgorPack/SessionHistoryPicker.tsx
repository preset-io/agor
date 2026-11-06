import type { AgorPackPreflightTeammate, AgorPackSessionMode } from '@agor/core/types';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Flex, Segmented, Typography } from 'antd';
import { exportEstimate } from './packCheck';
import { megabytes, PACK_COPY } from './packCopy';

export interface SessionHistoryPickerProps {
  value: AgorPackSessionMode;
  onChange: (value: AgorPackSessionMode) => void;
  /** Null while the preflight loads (counts are left out). */
  preflight: AgorPackPreflightTeammate[] | null;
  includeOthers: boolean;
}

/** None / Last 90 days / All, each with its session count and size. */
export const SessionHistoryPicker: React.FC<SessionHistoryPickerProps> = ({
  value,
  onChange,
  preflight,
  includeOthers,
}) => {
  const detail = (mode: AgorPackSessionMode) => {
    if (mode === 'none') return PACK_COPY.histNoneD;
    if (!preflight) return '…';
    const { sessions } = exportEstimate(preflight, mode, includeOthers);
    const bytes = preflight.reduce(
      (sum, teammate) =>
        sum +
        (mode === 'all' ? teammate.session_bytes.own : teammate.session_bytes.recent_own) +
        (includeOthers
          ? mode === 'all'
            ? teammate.session_bytes.others
            : teammate.session_bytes.recent_others
          : 0),
      0
    );
    return `${sessions.toLocaleString()} ${sessions === 1 ? 'session' : PACK_COPY.cntSessions}, ${megabytes(bytes)} MB`;
  };
  const option = (mode: AgorPackSessionMode, label: string) => ({
    value: mode,
    label: (
      <Flex vertical style={{ padding: '4px 0', lineHeight: 1.3 }}>
        <span>{label}</span>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {detail(mode)}
        </Typography.Text>
      </Flex>
    ),
  });

  return (
    <Flex vertical gap={6}>
      <Typography.Text strong>{PACK_COPY.histTitle}</Typography.Text>
      <Segmented<AgorPackSessionMode>
        block
        value={value}
        onChange={onChange}
        aria-label={PACK_COPY.histTitle}
        options={[
          option('last_90_days', PACK_COPY.hist90),
          option('all', PACK_COPY.histAll),
          option('none', PACK_COPY.histNone),
        ]}
      />
      <Typography.Text type="secondary">
        <InfoCircleOutlined /> {PACK_COPY.histNote}
      </Typography.Text>
    </Flex>
  );
};
