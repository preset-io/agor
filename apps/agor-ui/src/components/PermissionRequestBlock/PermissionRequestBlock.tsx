/**
 * PermissionRequestBlock - Displays a permission request awaiting approval
 *
 * Shows:
 * - Tool name and description
 * - Tool input parameters in readable format
 * - Approve/Deny action buttons
 * - Visual indication that system is waiting
 */

import {
  type Message,
  type PermissionRequestContent,
  PermissionScope,
  PermissionStatus,
} from '@agor/core/types';
import { CheckOutlined, CloseOutlined, LockOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Radio, Select, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { Tag } from '../Tag';

const { Title, Paragraph } = Typography;

interface PermissionRequestBlockProps {
  message: Message;
  content: PermissionRequestContent;
  isActive: boolean; // true if awaiting decision and can interact
  isWaiting?: boolean; // true if pending but waiting for previous permission
  onApprove?: (messageId: string, scope: PermissionScope) => void;
  onDeny?: (messageId: string) => void;
}

export const PermissionRequestBlock: React.FC<PermissionRequestBlockProps> = ({
  message,
  content,
  isActive,
  isWaiting = false,
  onApprove,
  onDeny,
}) => {
  const { token } = theme.useToken();
  const [remember, setRemember] = useState<boolean>(false);
  const [rememberScope, setRememberScope] = useState<PermissionScope>(PermissionScope.PROJECT);

  const { tool_name, tool_input, status, approved_at } = content;

  // Determine the state: active, approved, denied, or waiting
  const isApproved = status === PermissionStatus.APPROVED;
  const isDenied = status === PermissionStatus.DENIED;

  // State-based styling
  const getStateStyle = () => {
    if (isWaiting) {
      return {
        background: 'rgba(0, 0, 0, 0.02)',
        border: `1px solid ${token.colorBorder}`,
        opacity: 0.7,
      };
    }
    if (isActive) {
      return {
        background: 'rgba(255, 193, 7, 0.05)',
        border: `1px solid ${token.colorWarningBorder}`,
      };
    }
    if (isApproved) {
      return {
        background: 'rgba(82, 196, 26, 0.03)',
        border: `1px solid ${token.colorSuccessBorder}`,
      };
    }
    if (isDenied) {
      return {
        background: 'rgba(255, 77, 79, 0.03)',
        border: `1px solid ${token.colorErrorBorder}`,
      };
    }
    return {};
  };

  const getIcon = () => {
    if (isActive) return <LockOutlined style={{ fontSize: 20, color: token.colorWarning }} />;
    if (isApproved) return <CheckOutlined style={{ fontSize: 20, color: token.colorSuccess }} />;
    if (isDenied) return <CloseOutlined style={{ fontSize: 20, color: token.colorError }} />;
    return null;
  };

  const getTitle = () => {
    if (isWaiting) return 'Waiting for Previous Permission';
    if (isActive) return 'Permission Required';
    if (isApproved) return 'Permission Approved';
    if (isDenied) return 'Permission Denied';
    return 'Permission Request';
  };

  const getSubtitle = () => {
    if (isActive) return 'The agent needs your approval to continue';
    if (isApproved && approved_at) {
      return `Approved ${new Date(approved_at).toLocaleString()}`;
    }
    if (isDenied && approved_at) {
      return `Denied ${new Date(approved_at).toLocaleString()}`;
    }
    return '';
  };

  return (
    <Card
      style={{
        marginTop: token.sizeUnit * 2,
        ...getStateStyle(),
      }}
      styles={{
        body: {
          padding: token.sizeUnit * 2,
        },
      }}
    >
      <Space direction="vertical" size={token.sizeUnit * 1.5} style={{ width: '100%' }}>
        {/* Header */}
        <Space size={token.sizeUnit}>
          {getIcon()}
          <div>
            <Title level={5} style={{ margin: 0 }}>
              {getTitle()}
            </Title>
            {getSubtitle() && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {getSubtitle()}
              </Typography.Text>
            )}
          </div>
        </Space>

        {/* Tool Details */}
        <div>
          <Space size={token.sizeUnit / 2}>
            <Typography.Text strong>Tool:</Typography.Text>
            <Tag color="blue">{tool_name}</Tag>
          </Space>
        </div>

        {/* Tool Input - show only if active or in detailed view */}
        {isActive && Object.keys(tool_input).length > 0 && (
          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              Parameters:
            </Typography.Text>
            <Descriptions
              size="small"
              column={1}
              bordered
              style={{
                marginTop: token.sizeUnit,
              }}
              items={Object.entries(tool_input).map(([key, value]) => ({
                key,
                label: (
                  <Typography.Text code style={{ fontSize: 11 }}>
                    {key}
                  </Typography.Text>
                ),
                children: (
                  <Paragraph
                    code
                    style={{
                      fontSize: 12,
                      margin: 0,
                      padding: token.sizeUnit,
                      backgroundColor: token.colorBgContainer,
                      borderRadius: token.borderRadius,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                  </Paragraph>
                ),
              }))}
            />
          </div>
        )}

        {/* Timestamp - show only for active requests */}
        {isActive && message.timestamp && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Requested at {new Date(message.timestamp).toLocaleString()}
          </Typography.Text>
        )}

        {/* Action Buttons - show only when active */}
        {isActive && onApprove && onDeny && (
          <Space direction="vertical" size={token.sizeUnit} style={{ width: '100%' }}>
            {/* Radio group for remember choice */}
            <Radio.Group
              value={remember}
              onChange={(e) => setRemember(e.target.value)}
              style={{ width: '100%' }}
            >
              <Space direction="vertical" size={token.sizeUnit / 2} style={{ width: '100%' }}>
                <Radio value={false}>Allow once</Radio>
                <Space size={token.sizeUnit / 2} style={{ width: '100%', alignItems: 'center' }}>
                  <Radio value={true}>Remember for this</Radio>
                  <Select
                    value={rememberScope}
                    onChange={setRememberScope}
                    disabled={!remember}
                    style={{ width: 200 }}
                    size="small"
                    options={[
                      { value: PermissionScope.PROJECT, label: 'Project (.claude/)' },
                      { value: PermissionScope.USER, label: 'User (~/.claude/)' },
                      { value: PermissionScope.LOCAL, label: 'Local (gitignored)' },
                    ]}
                  />
                </Space>
              </Space>
            </Radio.Group>

            {/* Action buttons */}
            <Space size={token.sizeUnit}>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={() =>
                  onApprove?.(message.message_id, remember ? rememberScope : PermissionScope.ONCE)
                }
                style={{ backgroundColor: token.colorSuccess }}
              >
                Approve
              </Button>
              <Button danger icon={<CloseOutlined />} onClick={() => onDeny?.(message.message_id)}>
                Deny
              </Button>
            </Space>
          </Space>
        )}
      </Space>
    </Card>
  );
};
