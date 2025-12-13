/**
 * Force Password Change Modal
 *
 * Shown when user.must_change_password is true.
 * User must change their password before continuing.
 */

import type { User } from '@agor/core/types';
import { LockOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Form, Input, Modal, Typography } from 'antd';
import { useState } from 'react';

const { Text } = Typography;

interface ForcePasswordChangeModalProps {
  open: boolean;
  user: User | null;
  onChangePassword: (userId: string, newPassword: string) => Promise<void>;
  onLogout: () => void;
}

export function ForcePasswordChangeModal({
  open,
  user,
  onChangePassword,
  onLogout,
}: ForcePasswordChangeModalProps) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!user) return;

    try {
      const values = await form.validateFields();
      setLoading(true);
      setError(null);

      await onChangePassword(user.user_id, values.newPassword);

      // Success - modal will close when user.must_change_password becomes false
      form.resetFields();
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        // Form validation error, ignore
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={
        <span>
          <WarningOutlined style={{ color: '#faad14', marginRight: 8 }} />
          Password Change Required
        </span>
      }
      open={open}
      onOk={handleSubmit}
      okText="Change Password"
      cancelText="Logout"
      onCancel={onLogout}
      confirmLoading={loading}
      closable={false}
      maskClosable={false}
      keyboard={false}
      width={400}
    >
      <Alert
        type="warning"
        message="Your administrator requires you to change your password before continuing."
        style={{ marginBottom: 24 }}
        showIcon
      />

      {error && (
        <Alert
          type="error"
          message={error}
          style={{ marginBottom: 16 }}
          showIcon
          closable
          onClose={() => setError(null)}
        />
      )}

      <Form form={form} layout="vertical">
        <Form.Item
          name="newPassword"
          label="New Password"
          rules={[
            { required: true, message: 'Please enter a new password' },
            { min: 8, message: 'Password must be at least 8 characters' },
          ]}
        >
          <Input.Password
            prefix={<LockOutlined style={{ color: 'rgba(255, 255, 255, 0.45)' }} />}
            placeholder="Enter new password"
            autoComplete="new-password"
          />
        </Form.Item>

        <Form.Item
          name="confirmPassword"
          label="Confirm Password"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: 'Please confirm your password' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('newPassword') === value) {
                  return Promise.resolve();
                }
                return Promise.reject(new Error('Passwords do not match'));
              },
            }),
          ]}
        >
          <Input.Password
            prefix={<LockOutlined style={{ color: 'rgba(255, 255, 255, 0.45)' }} />}
            placeholder="Confirm new password"
            autoComplete="new-password"
          />
        </Form.Item>
      </Form>

      <Text type="secondary" style={{ fontSize: 12 }}>
        After changing your password, you will be able to continue using the application.
      </Text>
    </Modal>
  );
}
