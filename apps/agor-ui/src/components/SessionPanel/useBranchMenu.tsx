import type { Branch } from '@agor-live/client';
import {
  BranchesOutlined,
  CalendarOutlined,
  CloudServerOutlined,
  EditOutlined,
  ExportOutlined,
  FileTextOutlined,
  FolderOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  StopOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Flex, type MenuProps, Tooltip, Typography } from 'antd';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAgorStore } from '../../store/agorStore';
import { selectRepoById } from '../../store/selectors';
import { getBranchEnvironmentControls } from '../BranchHeaderPill/branchEnvironmentControls';
import type { BranchModalTab } from '../BranchModal/BranchModal';
import { getEnvironmentStopTooltip } from '../EnvironmentPill/environmentStatusCopy';

const STATUS_TEXT: Record<string, string> = {
  running: 'Running',
  starting: 'Starting…',
  stopping: 'Stopping…',
  error: 'Failed',
};

/** A disabled item explains itself on hover, like the pill's buttons. */
const withReason = (label: string, reason: string | undefined) =>
  reason ? (
    <Tooltip title={reason}>
      <span>{label}</span>
    </Tooltip>
  ) : (
    label
  );

/** The branch pill's actions as a "Branch" group for the session's ⋯ menu. */
export function useBranchMenu(branch: Branch | null, connectionDisabled: boolean) {
  const repoById = useAgorStore(selectRepoById);
  const { onOpenBranch, onStartEnvironment, onStopEnvironment, onViewLogs } = useAppActions();
  const repo = branch ? repoById.get(branch.repo_id) : undefined;
  if (!branch || !repo) return { items: [], environmentFailed: false };

  const controls = getBranchEnvironmentControls(repo, branch, {
    connectionDisabled,
    canStart: !!onStartEnvironment,
    canStopHandler: !!onStopEnvironment,
  });
  const { env, hasConfig, environmentUrl, controlDisabledTooltip } = controls;
  const branchId = branch.branch_id;
  const open = (tab?: BranchModalTab) => () => onOpenBranch?.(branchId, tab);

  const environmentItems: NonNullable<MenuProps['items']> = [
    ...(hasConfig && controls.canStop && onStopEnvironment
      ? [
          {
            key: 'branch-env-stop',
            icon: <StopOutlined />,
            label: withReason(
              'Stop environment',
              controls.stopDisabled
                ? (controlDisabledTooltip ?? getEnvironmentStopTooltip(env, true))
                : undefined
            ),
            disabled: controls.stopDisabled,
            onClick: () => onStopEnvironment(branchId),
          },
        ]
      : hasConfig && onStartEnvironment
        ? [
            {
              key: 'branch-env-start',
              icon: <PlayCircleOutlined />,
              label: withReason(
                'Start environment',
                controls.startDisabled
                  ? (controlDisabledTooltip ??
                      (controls.isRunning ? 'Environment running' : undefined))
                  : undefined
              ),
              disabled: controls.startDisabled,
              onClick: () => onStartEnvironment(branchId),
            },
          ]
        : []),
    ...(hasConfig && onViewLogs && controls.effectiveEnv.logs
      ? [
          {
            key: 'branch-env-logs',
            icon: <FileTextOutlined />,
            label: withReason('View logs', controlDisabledTooltip),
            disabled: !!controlDisabledTooltip,
            onClick: () => onViewLogs(branchId),
          },
        ]
      : []),
    ...(onOpenBranch
      ? [
          {
            key: 'branch-env-configure',
            icon: <SettingOutlined />,
            label: 'Configure environment',
            onClick: open('environment'),
          },
        ]
      : []),
  ];

  const items: NonNullable<MenuProps['items']> = [
    {
      type: 'group',
      key: 'branch',
      label: 'Branch',
      children: [
        ...(controls.isRunning && environmentUrl
          ? [
              {
                key: 'branch-open-app',
                icon: <ExportOutlined />,
                label: 'Open app',
                onClick: () => window.open(environmentUrl, '_blank', 'noopener,noreferrer'),
              },
            ]
          : []),
        ...(environmentItems.length
          ? [
              {
                key: 'branch-environment',
                icon: <CloudServerOutlined />,
                label: (
                  <Flex justify="space-between" gap="middle">
                    Environment{' '}
                    <Typography.Text type={controls.status === 'error' ? 'danger' : 'secondary'}>
                      {hasConfig ? (STATUS_TEXT[controls.status] ?? 'Stopped') : 'Not configured'}
                    </Typography.Text>
                  </Flex>
                ),
                children: environmentItems,
              },
            ]
          : []),
        ...(onOpenBranch
          ? [
              {
                key: 'branch-details',
                icon: <BranchesOutlined />,
                label: 'Branch details',
                onClick: open(),
              },
              {
                key: 'branch-sessions',
                icon: <TeamOutlined />,
                label: 'Sessions',
                onClick: open('sessions'),
              },
              {
                key: 'branch-files',
                icon: <FolderOutlined />,
                label: 'Files',
                onClick: open('files'),
              },
              {
                key: 'branch-schedule',
                icon: <CalendarOutlined />,
                label: 'Schedule',
                onClick: open('schedule'),
              },
              { key: 'branch-edit', icon: <EditOutlined />, label: 'Edit branch', onClick: open() },
            ]
          : []),
      ],
    },
  ];
  return { items, environmentFailed: controls.status === 'error' };
}
