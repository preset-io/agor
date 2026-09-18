import type { TranscriptTruncation } from '@agor-live/client';
import { Typography } from 'antd';
import type { ReactNode } from 'react';

export function TranscriptTruncationNotice({
  truncations,
  children,
}: {
  truncations: (TranscriptTruncation | undefined)[];
  children?: ReactNode;
}) {
  const fields = truncations.flatMap((truncation) => Object.entries(truncation ?? {}));
  if (fields.length === 0) return null;

  return (
    <Typography.Paragraph type="secondary" role="note">
      {children}
      Transcript shortened:{' '}
      {fields
        .map(
          ([field, size]) =>
            `${field} (originally ${size.original_bytes.toLocaleString()} serialized bytes)`
        )
        .join(', ')}
      . {fields.some(([field]) => field === 'diff') && 'Diff too large to preview. '}
      Full data for these fields is unavailable in the saved transcript. Shortened results are
      incomplete and may not be valid JSON; execution was not changed.
    </Typography.Paragraph>
  );
}
