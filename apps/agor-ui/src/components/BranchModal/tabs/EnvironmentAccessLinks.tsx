import type { BranchEnvironmentInstance } from '@agor-live/client';
import { Space, Typography } from 'antd';
import { getEnvironmentAccessUrls } from '../../../utils/environmentAccessUrls';

export function EnvironmentAccessLinks({
  environment,
  appUrl,
}: {
  environment?: BranchEnvironmentInstance;
  appUrl?: string;
}) {
  const links = getEnvironmentAccessUrls(environment, appUrl);
  if (!links.length) return null;
  return (
    <Space
      orientation="vertical"
      aria-label="Environment access links"
      style={{ minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <Typography.Text strong>Environment access links</Typography.Text>
      {links.map(({ name, url }) => (
        <Typography.Link
          key={`${name}:${url}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {name}
        </Typography.Link>
      ))}
    </Space>
  );
}
