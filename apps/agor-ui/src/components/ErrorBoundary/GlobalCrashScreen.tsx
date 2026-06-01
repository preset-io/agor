import { CopyOutlined, FrownOutlined, GithubOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Collapse, Space, Typography, theme } from 'antd';
import type { ErrorInfo } from 'react';
import { useState } from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import { buildGitHubIssueUrl, buildMarkdownReport, firstComponentFromStack } from './crashReport';

const { Title, Paragraph, Text } = Typography;

interface GlobalCrashScreenProps {
  error: Error;
  errorInfo: ErrorInfo | null;
}

export function GlobalCrashScreen({ error, errorInfo }: GlobalCrashScreenProps) {
  const { token } = theme.useToken();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyToClipboard(buildMarkdownReport(error, errorInfo));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleReload = () => {
    window.location.reload();
  };

  const githubUrl = buildGitHubIssueUrl(error, errorInfo);
  const component = firstComponentFromStack(errorInfo?.componentStack);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        backgroundColor: token.colorBgLayout,
      }}
    >
      <Card
        style={{
          maxWidth: 640,
          width: '100%',
          textAlign: 'center',
        }}
        styles={{ body: { padding: '2.5rem 2rem' } }}
      >
        {/*
          TODO(asset): swap this placeholder for a generated mascot at
          /apps/agor-ui/public/error-mascot.svg. Drop the file in, then replace
          this <FrownOutlined /> with <img src="/error-mascot.svg" ... />.
        */}
        <FrownOutlined
          style={{
            fontSize: 96,
            color: token.colorTextTertiary,
            marginBottom: token.marginLG,
          }}
        />

        <Title level={2} style={{ marginTop: 0, marginBottom: token.marginXS }}>
          Well, that wasn't supposed to happen.
        </Title>
        <Paragraph style={{ color: token.colorTextSecondary, marginBottom: token.marginLG }}>
          The UI hit an unexpected error and couldn't finish rendering. Reloading usually gets you
          going again. If it keeps happening, the report below will help us fix it.
        </Paragraph>

        <Space wrap style={{ justifyContent: 'center', marginBottom: token.marginLG }}>
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
          <Button type="primary" icon={<ReloadOutlined />} onClick={handleReload}>
            Reload page
          </Button>
        </Space>

        <Collapse
          ghost
          items={[
            {
              key: 'details',
              label: <Text type="secondary">Show technical details</Text>,
              children: (
                <div style={{ textAlign: 'left' }}>
                  <Paragraph style={{ marginBottom: token.marginSM }}>
                    <Text strong>Component:</Text> <Text code>{component}</Text>
                    <br />
                    <Text strong>Error:</Text> <Text code>{error.message || String(error)}</Text>
                  </Paragraph>
                  <pre
                    style={{
                      maxHeight: 240,
                      overflow: 'auto',
                      fontSize: 12,
                      padding: token.paddingSM,
                      backgroundColor: token.colorBgContainerDisabled,
                      borderRadius: token.borderRadiusSM,
                      margin: 0,
                    }}
                  >
                    {(errorInfo?.componentStack ?? error.stack ?? '(no stack available)').trim()}
                  </pre>
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
