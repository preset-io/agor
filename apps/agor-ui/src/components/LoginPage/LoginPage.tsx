/**
 * Login Page Component
 *
 * Beautiful authentication page with Ant Design components
 */

import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Divider, Form, Input, Space, Typography, theme } from 'antd';
import { useState } from 'react';
import { BRAND, brandMarkHref } from '../../branding/brand';
import { BrandLogo } from '../BrandLogo';
import { ParticleBackground } from './ParticleBackground';

const { Text } = Typography;

function currentReturnToPath(): string | null {
  if (typeof window === 'undefined') return null;

  // Send only a relative Agor route to the external launcher. Avoiding an
  // absolute URL keeps this from becoming an open-redirect primitive if the
  // launcher blindly follows `return_to`.
  const pathname = window.location.pathname.startsWith('//') ? '/' : window.location.pathname;
  return `${pathname}${window.location.search}${window.location.hash}`;
}

function addReturnToParam(loginRedirectUrl: string): string {
  const returnTo = currentReturnToPath();
  if (!returnTo) return loginRedirectUrl;

  try {
    const url = new URL(loginRedirectUrl);
    url.searchParams.set('return_to', returnTo);
    return url.toString();
  } catch {
    return loginRedirectUrl;
  }
}

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<boolean>;
  loading?: boolean;
  error?: string | null;
  externalLaunchLoginRedirectUrl?: string;
}

export function LoginPage({
  onLogin,
  loading = false,
  error,
  externalLaunchLoginRedirectUrl,
}: LoginPageProps) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [showLocalLogin, setShowLocalLogin] = useState(false);
  const { token } = theme.useToken();
  const useExternalLaunch = !!externalLaunchLoginRedirectUrl;
  const externalLaunchHref = externalLaunchLoginRedirectUrl
    ? addReturnToParam(externalLaunchLoginRedirectUrl)
    : undefined;
  const showLoginForm = !useExternalLaunch || showLocalLogin;
  const isLaunchError = error?.startsWith('Launch sign-in failed') ?? false;

  const handleSubmit = async (values: { email: string; password: string }) => {
    setSubmitting(true);
    try {
      await onLogin(values.email, values.password);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100dvh', // Dynamic viewport height for mobile
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 50%, #0f1f1e 100%)',
        padding: '16px',
        position: 'relative',
        overflow: 'auto',
      }}
    >
      {/* Particle background */}
      <ParticleBackground />

      {/* Attribution */}
      <a
        href="https://particles.js.org"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          fontSize: 10,
          color: 'rgba(46, 154, 146, 0.3)',
          textDecoration: 'none',
          zIndex: 0,
          transition: 'color 0.3s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'rgba(46, 154, 146, 0.6)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'rgba(46, 154, 146, 0.3)';
        }}
      >
        🤍 tsparticles
      </a>

      <Card
        style={{
          width: '100%',
          maxWidth: 420,
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          position: 'relative',
          zIndex: 1,
          margin: 'auto',
        }}
        variant="borderless"
      >
        {/* Header */}
        <Space orientation="vertical" size="large" style={{ width: '100%', marginBottom: 24 }}>
          <div style={{ textAlign: 'center' }}>
            <img
              src={brandMarkHref()}
              alt={BRAND.name}
              style={{
                width: 72,
                height: 72,
                marginBottom: 16,
                objectFit: 'cover',
                borderRadius: '50%',
                display: 'block',
                margin: '0 auto 16px',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <BrandLogo level={1} />
            </div>
            <div>
              <Text type="secondary">Team command center for all things agentic</Text>
            </div>
            <Divider style={{ margin: '16px 0 0 0' }} />
          </div>
        </Space>

        {/* Error Alert */}
        {error && (
          <Alert
            type="error"
            title={isLaunchError ? 'Launch sign-in failed' : 'Login Failed'}
            description={error}
            showIcon
            closable
            style={{ marginBottom: 24 }}
          />
        )}

        {useExternalLaunch && (
          <Space orientation="vertical" size="middle" style={{ width: '100%', marginBottom: 24 }}>
            {!error && (
              <Alert
                type="info"
                title="Open from your workspace"
                description="This runtime is configured for external launch sign-in. Return to your workspace to open a fresh launch link."
                showIcon
              />
            )}
            <Button
              type="primary"
              href={externalLaunchHref}
              block
              data-testid="external-launch-return"
            >
              Return to workspace
            </Button>
            {!showLocalLogin && (
              <Button type="link" block onClick={() => setShowLocalLogin(true)}>
                Use local login instead
              </Button>
            )}
          </Space>
        )}

        {/* Login Form */}
        {showLoginForm && (
          <>
            {useExternalLaunch && <Divider style={{ margin: '0 0 24px 0' }}>Local login</Divider>}
            <Form
              form={form}
              name="login"
              layout="vertical"
              onFinish={handleSubmit}
              autoComplete="off"
            >
              <Form.Item
                name="email"
                rules={[
                  { required: true, message: 'Please enter your email' },
                  { type: 'email', message: 'Please enter a valid email' },
                ]}
              >
                <Input
                  prefix={<MailOutlined style={{ color: token.colorTextQuaternary }} />}
                  placeholder="Email address"
                  autoComplete="email"
                />
              </Form.Item>

              <Form.Item
                name="password"
                rules={[{ required: true, message: 'Please enter your password' }]}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: token.colorTextQuaternary }} />}
                  placeholder="Password"
                  autoComplete="current-password"
                />
              </Form.Item>

              <Form.Item style={{ marginBottom: 8 }}>
                <Button type="primary" htmlType="submit" loading={submitting || loading} block>
                  Sign In
                </Button>
              </Form.Item>
            </Form>
          </>
        )}
      </Card>
    </div>
  );
}
