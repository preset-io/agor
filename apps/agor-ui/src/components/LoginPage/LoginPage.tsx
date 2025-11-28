/**
 * Login Page Component
 *
 * Beautiful authentication page with Ant Design components
 */

import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Divider, Form, Input, Space, Typography } from 'antd';
import { useState } from 'react';
import { BrandLogo } from '../BrandLogo';
import { ParticleBackground } from './ParticleBackground';

const { Text } = Typography;

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<boolean>;
  loading?: boolean;
  error?: string | null;
}

export function LoginPage({ onLogin, loading = false, error }: LoginPageProps) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

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
        <Space direction="vertical" size="large" style={{ width: '100%', marginBottom: 24 }}>
          <div style={{ textAlign: 'center' }}>
            <img
              src={`${import.meta.env.BASE_URL}favicon.png`}
              alt="Agor Logo"
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
              <Text type="secondary">Next-gen agent orchestration</Text>
            </div>
            <Divider style={{ margin: '16px 0 0 0' }} />
          </div>
        </Space>

        {/* Error Alert */}
        {error && (
          <Alert
            type="error"
            message="Login Failed"
            description={
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <div>{error}</div>
                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px solid rgba(255,255,255,0.1)',
                  }}
                >
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    💡 First time setting up? Create an admin user:
                  </Text>
                  <br />
                  <code style={{ fontSize: 11 }}>agor user create-admin</code>
                </div>
              </Space>
            }
            showIcon
            closable
            style={{ marginBottom: 24 }}
          />
        )}

        {/* Login Form */}
        <Form form={form} name="login" layout="vertical" onFinish={handleSubmit} autoComplete="off">
          <Form.Item
            name="email"
            rules={[
              { required: true, message: 'Please enter your email' },
              { type: 'email', message: 'Please enter a valid email' },
            ]}
          >
            <Input
              prefix={<MailOutlined style={{ color: 'rgba(255, 255, 255, 0.45)' }} />}
              placeholder="Email address"
              autoComplete="email"
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: 'Please enter your password' }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: 'rgba(255, 255, 255, 0.45)' }} />}
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

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <Space direction="vertical" size={4}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              New user? <code>agor user create-admin</code>
            </Text>
          </Space>
        </div>
      </Card>
    </div>
  );
}
