import type { Branch } from '@agor-live/client';
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
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useAgorStore } from '../../store/agorStore';
import {
  makeBoardSelector,
  makeBranchSelector,
  makeRepoSelector,
  makeSessionsForBranchSelector,
} from '../../store/selectors';
import { getEnvironmentAccessUrls } from '../../utils/environmentAccessUrls';
import { getEffectiveEnv } from '../../utils/environmentConfig';
import {
  getEnvironmentControlState,
  getEnvironmentState,
  getEnvironmentStateDescription,
} from '../../utils/environmentState';
import { teammateLabel } from '../../utils/teammateLabels';
import { formatRelativeTimeSafe } from '../../utils/time';
import { EnvironmentStatusIcon } from '../EnvironmentPill';
import { isEnvironmentUnconfirmed } from '../EnvironmentPill/environmentStatusCopy';
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

/** The branch's app: its own link, else the first one its environment reports. */
export function branchAppUrl(branch: Branch): string | undefined {
  return branch.app_url || getEnvironmentAccessUrls(branch.environment_instance)[0]?.url;
}

/**
 * Branch details in the board's preview: what the teammate did, the app and
 * pull request, the conversations about it, and its environment folded away.
 * Environment actions are the same handlers the branch strip uses; the daemon
 * enforces who may run them.
 */
export const BranchDetailsPreview: React.FC<{ branch: Branch }> = ({ branch }) => {
  const { token } = theme.useToken();
  const { onSessionClick, onStartEnvironment, onStopEnvironment, onViewLogs } = useAppActions();
  const connectionDisabled = useConnectionDisabled();
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
  const appUrl = branchAppUrl(branch);
  const prUrl = branch.pull_request_url;
  const prNumber = prUrl ? pullRequestNumber(prUrl) : null;

  const env = branch.environment_instance;
  const effectiveEnv = repo ? getEffectiveEnv(repo) : null;
  const hasConfig = !!effectiveEnv?.hasConfig;
  const envState = getEnvironmentState(env);
  const { startDisabled, stopDisabled } = getEnvironmentControlState(env, {
    hasConfig,
    connectionDisabled,
  });

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
          {heading(`What ${teammate ? teammateLabel(teammate) : 'your teammate'} did`)}
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
                onClick={() => onSessionClick?.(session.session_id)}
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
                  {onViewLogs && effectiveEnv?.logs && (
                    <Button
                      size="small"
                      icon={<FileTextOutlined />}
                      onClick={() => onViewLogs(branch.branch_id)}
                    >
                      Logs
                    </Button>
                  )}
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
  if (branchAppUrl(branch)) return 'Live';
  return undefined;
}
