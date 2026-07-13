import type { TranscriptContentProjection } from '@agor-live/client';
import { WarningOutlined } from '@ant-design/icons';
import { theme } from 'antd';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatTranscriptBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

export function TranscriptProjectionNotice({
  projection,
}: {
  projection?: TranscriptContentProjection;
}) {
  const { token } = theme.useToken();

  if (!projection) return null;

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: token.sizeUnit,
        marginBottom: token.sizeUnit,
        color: token.colorWarningText,
        fontSize: token.fontSizeSM,
      }}
    >
      <WarningOutlined aria-hidden />
      <span>
        Result truncated for transcript storage; showing{' '}
        {formatTranscriptBytes(projection.persisted_content_bytes)} of{' '}
        {formatTranscriptBytes(projection.original_content_bytes)}.
      </span>
    </div>
  );
}
