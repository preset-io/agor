import type { AgorClient, Branch, User } from '@agor-live/client';
import {
  ExportOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  PullRequestOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Button, Collapse, Flex, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useBoardViewContext } from '../../contexts/BoardViewContext';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useAuthConfigSnapshot } from '../../hooks/useAuthConfig';
import { useBranchAccess } from '../../hooks/useBranchAccess';
import { useAgorStore } from '../../store/agorStore';
import {
  makeBoardSelector,
  makeBranchSelector,
  makeRepoSelector,
  makeSessionsForBranchSelector,
} from '../../store/selectors';
import { canControlBranchEnvironment } from '../../utils/branchAccess';
import { getEnvironmentAccessUrls } from '../../utils/environmentAccessUrls';
import { hasEnvironmentLogs } from '../../utils/environmentCommand';
import { getEffectiveEnv } from '../../utils/environmentConfig';
import {
  getEnvironmentControlState,
  getEnvironmentState,
  getEnvironmentStateDescription,
} from '../../utils/environmentState';
import { teammateLabel } from '../../utils/teammateLabels';
import { formatRelativeTimeSafe } from '../../utils/time';
import { EnvironmentStatusIcon } from '../EnvironmentPill';
import {
  ENVIRONMENT_NO_CONTROL,
  isEnvironmentUnconfirmed,
} from '../EnvironmentPill/environmentStatusCopy';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  getSessionTabStatus,
  getSessionTabTitle,
  SessionTabStatusIcon,
} from '../SessionTabs/sessionTabStatus';
import { ToolIcon } from '../ToolIcon';

/** The pull request number from a `/pull/<n>` link, or null. */
export function pullRequestNumber(url: string): string | null {
  return url.match(/\/pull\/(\d+)/)?.[1] ?? null;
}

/**
 * Branch details in the board's preview: what the teammate did, the app and
 * pull request, the conversations about it, and its environment folded away.
 * Environment actions are the same handlers the branch strip uses, offered to
 * people who may run them (the daemon still decides).
 */
export const BranchDetailsPreview: React.FC<{
  branch: Branch;
  client: AgorClient | null;
  user: User | null | undefined;
  /** The conversation on screen, marked as current. */
  currentSessionId?: string | null;
}> = ({ branch, client, user, currentSessionId }) => {
  const { token } = theme.useToken();
  const { onStartEnvironment, onStopEnvironment, onViewLogs } = useAppActions();
  const openConversation = useBoardViewContext()?.openConversation;
  const connectionDisabled = useConnectionDisabled();
  const { featuresConfig } = useAuthConfigSnapshot();
  const repo = useAgorStore(useMemo(() => makeRepoSelector(branch.repo_id), [branch.repo_id]));
  const board = useAgorStore(useMemo(() => makeBoardSelector(branch.board_id), [branch.board_id]));
  const teammate = useAgorStore(
    useMemo(() => makeBranchSelector(board?.primary_teammate_id), [board?.primary_teammate_id])
  );
  const branchSessions = useAgorStore(
    useMemo(() => makeSessionsForBranchSelector(branch.branch_id), [branch.branch_id])
  );
  const sessions = useMemo(
    () =>
      [...(branchSessions ?? [])].sort((a, b) =>
        (b.last_updated || b.created_at).localeCompare(a.last_updated || a.created_at)
      ),
    [branchSessions]
  );

  const notes = branch.notes?.trim();
  const env = branch.environment_instance;
  const appUrl = getEnvironmentAccessUrls(env, branch.app_url)[0]?.url;
  const prUrl = branch.pull_request_url;
  const prNumber = prUrl ? pullRequestNumber(prUrl) : null;

  const effectiveEnv = repo ? getEffectiveEnv(repo) : null;
  const hasConfig = !!effectiveEnv?.hasConfig;
  const envState = getEnvironmentState(env);
  // Closed until access is known.
  const access = useBranchAccess(client, branch, user, hasConfig);
  const controlAccess = canControlBranchEnvironment(access, user?.role);
  const canControl = controlAccess ?? false;
  const { startDisabled, stopDisabled } = getEnvironmentControlState(env, {
    hasConfig,
    canControl,
    connectionDisabled,
  });
  const canViewLogs = hasEnvironmentLogs(
    env,
    branch.logs_command,
    featuresConfig?.environmentCommands?.shellLogs
  );

  const environmentLabel = (
    <Flex align="center" gap={token.marginXS} wrap>
      <Typography.Text strong>Environment</Typography.Text>
      <Flex align="center" gap={token.marginXXS}>
        {hasConfig && (
          <EnvironmentStatusIcon state={envState} unconfirmed={isEnvironmentUnconfirmed(env)} />
        )}
        <Typography.Text type="secondary">
          {hasConfig ? getEnvironmentStateDescription(envState) : 'Not set up'}
        </Typography.Text>
      </Flex>
    </Flex>
  );

  const heading = (text: string) => (
    <Typography.Title level={5} style={{ margin: 0, fontSize: token.fontSize }}>
      {text}
    </Typography.Title>
  );

  return (
    <Flex vertical gap={token.marginLG} style={{ padding: token.paddingMD }}>
      {notes && (
        <Flex vertical gap={token.marginXS}>
          {heading(teammate ? `What ${teammateLabel(teammate)} did` : 'Notes')}
          <MarkdownRenderer content={notes} />
        </Flex>
      )}

      {appUrl || prUrl ? (
        <Flex gap={token.marginXS} wrap>
          {appUrl && (
            <Button
              type="primary"
              icon={<ExportOutlined />}
              href={appUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open app
            </Button>
          )}
          {prUrl && (
            <Button
              icon={<PullRequestOutlined />}
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {prNumber ? `View pull request #${prNumber}` : 'View pull request'}
            </Button>
          )}
        </Flex>
      ) : (
        <Typography.Text type="secondary">No app or pull request for this branch.</Typography.Text>
      )}

      {sessions.length > 0 && (
        <Flex vertical gap={token.marginXXS}>
          {heading('Conversations about it')}
          {sessions.map((session) => {
            const time = formatRelativeTimeSafe(session.last_updated || session.created_at);
            return (
              <Button
                key={session.session_id}
                type="text"
                aria-current={session.session_id === currentSessionId || undefined}
                onClick={() => openConversation?.(session.session_id)}
                style={{ justifyContent: 'flex-start', paddingInline: token.paddingXS }}
              >
                <ToolIcon tool={session.agentic_tool} size={16} bordered={false} />
                <Typography.Text ellipsis style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  {getSessionTabTitle(session)}
                </Typography.Text>
                <SessionTabStatusIcon status={getSessionTabStatus(session)} />
                {time && (
                  <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                    {time}
                  </Typography.Text>
                )}
              </Button>
            );
          })}
        </Flex>
      )}

      {hasConfig ? (
        <Collapse
          ghost
          items={[
            {
              key: 'environment',
              label: environmentLabel,
              // Lined up with the other sections.
              styles: { header: { paddingInline: 0 }, body: { paddingInline: 0 } },
              children: (
                <Flex vertical gap={token.marginXS}>
                  {controlAccess === false && (
                    <Typography.Text type="secondary">{ENVIRONMENT_NO_CONTROL}</Typography.Text>
                  )}
                  <Flex gap={token.marginXS} wrap>
                    <Button
                      size="small"
                      icon={<PlayCircleOutlined />}
                      disabled={!onStartEnvironment || startDisabled}
                      onClick={() => onStartEnvironment?.(branch.branch_id)}
                    >
                      Start
                    </Button>
                    <Button
                      size="small"
                      icon={<StopOutlined />}
                      disabled={!onStopEnvironment || stopDisabled}
                      onClick={() => onStopEnvironment?.(branch.branch_id)}
                    >
                      Stop
                    </Button>
                    {onViewLogs && canViewLogs && (
                      <Button
                        size="small"
                        icon={<FileTextOutlined />}
                        disabled={!canControl}
                        onClick={() => onViewLogs(branch.branch_id)}
                      >
                        Logs
                      </Button>
                    )}
                  </Flex>
                </Flex>
              ),
            },
          ]}
        />
      ) : (
        // Nothing to fold away without a config.
        environmentLabel
      )}
    </Flex>
  );
};

/** Header status for a branch (A14): a pull request is ready to review; an app alone is live. */
export function branchPreviewStatus(branch: Branch): string | undefined {
  if (branch.pull_request_url) return 'Ready to review';
  if (getEnvironmentAccessUrls(branch.environment_instance, branch.app_url).length) return 'Live';
  return undefined;
}
