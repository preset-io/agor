/**
 * Force Password Change Modal
 *
 * Shown when user.must_change_password is true.
 * User must change their password before continuing.
 */

import type { User } from '@agor-live/client';
import { LockOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Form, Input, Modal, Typography, theme } from 'antd';
import { useLayoutEffect, useMemo, useState } from 'react';
import { useConnectionState } from '@/contexts/ConnectionContext';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useAuthConfig } from '../../hooks/useAuthConfig';
import {
  passwordPolicyHelp,
  passwordPolicyRequirements,
  passwordRules,
} from '../../utils/passwordPolicy';

const { Text } = Typography;

interface ForcePasswordChangeModalProps {
  open: boolean;
  user: User | null;
  onChangePassword: (
    userId: string,
    newPassword: string,
    shouldApply: () => boolean,
    isSameIdentity: () => boolean
  ) => Promise<void>;
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
  const { token } = theme.useToken();
  const { config: authConfig } = useAuthConfig();
  const passwordRequirements = passwordPolicyRequirements(authConfig?.passwordPolicy);
  const { connected, connecting, authGeneration } = useConnectionState();
  const identityKey = user ? `${user.user_id}:${user.role}` : null;
  const authorityScope = useMemo(
    () => (identityKey && connected && !connecting ? [identityKey, authGeneration] : null),
    [authGeneration, connected, connecting, identityKey]
  );
  const operationGuard = useAuthorityOperationGuard(authorityScope);
  const identityGuard = useAuthorityOperationGuard(identityKey ? [identityKey] : null);

  // Password drafts are identity-private. A reconnect cancels the operation
  // via authorityScope but deliberately does not erase a same-user draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: identityKey intentionally resets the Ant form for a replacement caller
  useLayoutEffect(() => {
    form.resetFields();
    setLoading(false);
    setError(null);
  }, [form, identityKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: authorityScope intentionally releases stale generation-owned UI locks
  useLayoutEffect(() => {
    setLoading(false);
  }, [authorityScope]);

  const handleSubmit = async () => {
    if (!user) return;
    const operation = operationGuard.begin();
    const identityOperation = identityGuard.begin();
    if (!operation.isCurrent() || !identityOperation.isCurrent()) return;

    try {
      const values = await form.validateFields();
      if (!operation.isCurrent()) return;
      setLoading(true);
      setError(null);

      await onChangePassword(
        user.user_id,
        values.newPassword,
        operation.isCurrent,
        identityOperation.isCurrent
      );
      if (!operation.isCurrent()) return;

      // Success - modal will close when user.must_change_password becomes false
      form.resetFields();
    } catch (err) {
      if (!operation.isCurrent()) return;
      if (err instanceof Error) {
        setError(err.message);
      } else {
        // Form validation error, ignore
      }
    } finally {
      if (operation.isCurrent()) setLoading(false);
    }
  };

  return (
    <Modal
      title={
        <span>
          <WarningOutlined style={{ color: token.colorWarning, marginRight: 8 }} />
          Password Change Required
        </span>
      }
      open={open}
      onOk={handleSubmit}
      okText="Change Password"
      cancelText="Logout"
      onCancel={() => {
        if (operationGuard.isCurrent()) onLogout();
      }}
      confirmLoading={loading}
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      width={400}
    >
      <Alert
        type="warning"
        title="Your administrator requires you to change your password before continuing."
        style={{ marginBottom: 24 }}
        showIcon
      />

      {error && (
        <Alert
          type="error"
          title={error}
          style={{ marginBottom: 16 }}
          showIcon
          closable
          onClose={() => setError(null)}
        />
      )}

      <Form key={identityKey ?? 'no-user'} form={form} layout="vertical">
        <Form.Item
          name="newPassword"
          label="New Password"
          help={passwordPolicyHelp(passwordRequirements)}
          rules={passwordRules(passwordRequirements, { required: true })}
        >
          <Input.Password
            prefix={<LockOutlined style={{ color: token.colorTextQuaternary }} />}
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
            prefix={<LockOutlined style={{ color: token.colorTextQuaternary }} />}
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
