/**
 * Getting Started Popover - Lightweight onboarding indicator in navbar
 *
 * Shows progress-based checklist:
 * - ✓ Repos configured
 * - ✓ Worktrees active
 * - ✗ Authenticate to use AI
 */

import type { User } from '@agor/core/types';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { Button, Popover, Progress, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

const { Text } = Typography;

export interface GettingStartedStats {
  repoCount: number;
  worktreeCount: number;
  hasAuthentication: boolean;
}

export interface GettingStartedPopoverProps {
  stats: GettingStartedStats;
  user?: User | null;
  onOpenSettings?: () => void;
  onOpenRepoSettings?: () => void;
  onOpenAuthSettings?: () => void;
  onOpenNewWorktree?: () => void;
  onDismiss?: () => void;
  children: React.ReactNode;
}

export const GettingStartedPopover: React.FC<GettingStartedPopoverProps> = ({
  stats,
  user,
  onOpenSettings,
  onOpenRepoSettings,
  onOpenAuthSettings,
  onOpenNewWorktree,
  onDismiss,
  children,
}) => {
  // Calculate completion percentage
  const totalSteps = 3;
  let completedSteps = 0;

  if (stats.repoCount > 0) completedSteps++;
  if (stats.worktreeCount > 0) completedSteps++;
  if (stats.hasAuthentication) completedSteps++;

  const progressPercent = Math.round((completedSteps / totalSteps) * 100);

  // Control popover open state
  // Open by default if onboarding not completed, close only via dismiss
  const [open, setOpen] = useState(false);

  // Open popover automatically when onboarding is not complete
  useEffect(() => {
    if (!user?.onboarding_completed) {
      setOpen(true);
    }
  }, [user?.onboarding_completed]);

  // Don't show if user has dismissed onboarding
  if (user?.onboarding_completed) {
    return <>{children}</>;
  }

  const handleDismiss = () => {
    setOpen(false);
    onDismiss?.();
  };

  const content = (
    <div style={{ width: 320 }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Text strong style={{ fontSize: 16 }}>
            Getting Started
          </Text>
        </div>

        <Progress
          percent={progressPercent}
          strokeColor="#13c2c2"
          trailColor="rgba(255, 255, 255, 0.1)"
          showInfo={true}
          format={(percent) => `${percent}%`}
        />

        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {/* Repos configured */}
          <Space
            align="start"
            size="small"
            style={{
              cursor: 'pointer',
              padding: '4px 8px',
              margin: '0 -8px',
              borderRadius: 4,
              transition: 'background-color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => {
              if (onOpenRepoSettings) {
                onOpenRepoSettings();
              }
            }}
          >
            {stats.repoCount > 0 ? (
              <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 16, marginTop: 2 }} />
            ) : (
              <CloseCircleOutlined style={{ color: '#d9d9d9', fontSize: 16, marginTop: 2 }} />
            )}
            <Text style={{ flex: 1 }}>
              {stats.repoCount > 0 ? `${stats.repoCount} repos configured` : 'No repos configured'}
            </Text>
          </Space>

          {/* Worktrees active */}
          <Space
            align="start"
            size="small"
            style={{
              cursor: 'pointer',
              padding: '4px 8px',
              margin: '0 -8px',
              borderRadius: 4,
              transition: 'background-color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => {
              if (onOpenNewWorktree) {
                onOpenNewWorktree();
              }
            }}
          >
            {stats.worktreeCount > 0 ? (
              <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 16, marginTop: 2 }} />
            ) : (
              <CloseCircleOutlined style={{ color: '#d9d9d9', fontSize: 16, marginTop: 2 }} />
            )}
            <Text style={{ flex: 1 }}>
              {stats.worktreeCount > 0
                ? `${stats.worktreeCount} worktrees active`
                : 'No worktrees created'}
            </Text>
          </Space>

          {/* Authentication */}
          <Space
            align="start"
            size="small"
            style={{
              cursor: 'pointer',
              padding: '4px 8px',
              margin: '0 -8px',
              borderRadius: 4,
              transition: 'background-color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => {
              if (onOpenAuthSettings) {
                onOpenAuthSettings();
              }
            }}
          >
            {stats.hasAuthentication ? (
              <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 16, marginTop: 2 }} />
            ) : (
              <CloseCircleOutlined style={{ color: '#faad14', fontSize: 16, marginTop: 2 }} />
            )}
            <Text style={{ flex: 1 }}>Authenticate to use AI</Text>
          </Space>
        </Space>

        {/* Documentation link */}
        <div style={{ paddingTop: 8, borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
          <Space size="small" style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button
              type="link"
              size="small"
              href="https://agor.live/guide/getting-started"
              target="_blank"
              rel="noopener noreferrer"
              style={{ padding: 0 }}
            >
              Docs
            </Button>
            <Button type="link" size="small" onClick={handleDismiss} style={{ padding: 0 }}>
              Dismiss
            </Button>
          </Space>
        </div>
      </Space>
    </div>
  );

  return (
    <Popover
      content={content}
      title={null}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomRight"
      overlayStyle={{ zIndex: 1050 }}
      styles={{
        container: {
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(8px)',
        },
        content: {
          backgroundColor: 'transparent',
        },
      }}
    >
      {children}
    </Popover>
  );
};
