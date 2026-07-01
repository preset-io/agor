import { CopyOutlined, GithubOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Card, Space, Typography, theme } from 'antd';
import type { ErrorInfo } from 'react';
import { useState } from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import { buildGitHubIssueUrl, buildMarkdownReport, firstComponentFromStack } from './crashReport';

const { Title, Paragraph, Text } = Typography;

interface CanvasCrashScreenProps {
  error: Error;
  errorInfo: ErrorInfo | null;
  // Clears the boundary's error state so the canvas subtree re-mounts, without
  // reloading the whole page (which would drop the rest of the app shell).
  onReset: () => void;
}

// Scoped fallback for the canvas boundary: fills the canvas panel while the
// surrounding app shell (header, panels, nav) stays interactive. Shares the
// same crash-report helpers as the global screen so auto-issue reporting is
// preserved, but recovers in place instead of forcing a full reload.
export function CanvasCrashScreen({ error, errorInfo, onReset }: CanvasCrashScreenProps) {
  const { token } = theme.useToken();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyToClipboard(buildMarkdownReport(error, errorInfo));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const githubUrl = buildGitHubIssueUrl(error, errorInfo);
  const component = firstComponentFromStack(errorInfo?.componentStack);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        backgroundColor: token.colorBgLayout,
      }}
    >
      <Card style={{ maxWidth: 520, width: '100%', textAlign: 'center' }}>
        <WarningOutlined
          style={{ fontSize: 56, color: token.colorWarning, marginBottom: token.marginMD }}
        />

        <Title level={4} style={{ marginTop: 0, marginBottom: token.marginXS }}>
          The canvas stopped rendering.
        </Title>
        <Paragraph style={{ color: token.colorTextSecondary, marginBottom: token.marginMD }}>
          The rest of Agor is still working. Reloading the canvas usually recovers it. If it keeps
          happening, the report below helps us fix it.
        </Paragraph>

        <Space wrap style={{ justifyContent: 'center' }}>
          <Button icon={<CopyOutlined />} onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy error details'}
          </Button>
          <Button
            icon={<GithubOutlined />}
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Report on GitHub
          </Button>
          <Button type="primary" icon={<ReloadOutlined />} onClick={onReset}>
            Reload canvas
          </Button>
        </Space>

        <Paragraph style={{ marginTop: token.marginMD, marginBottom: 0 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {component}: {error.message || String(error)}
          </Text>
        </Paragraph>
      </Card>
    </div>
  );
}
