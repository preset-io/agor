/**
 * Shared environment status column helpers for branch tables.
 * Used by both BranchesTable and TeammatesTable to avoid duplication.
 */

import type { Branch, Repo } from '@agor-live/client';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  GlobalOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { GlobalToken } from 'antd';
import { Badge, Button, Space, Tooltip } from 'antd';
import { getEffectiveEnv } from '../../utils/environmentConfig';

/** Render environment status icon for a branch */
export function renderEnvStatusIcon(branch: Branch, token: GlobalToken) {
  const status = branch.environment_instance?.status;
  const healthStatus = branch.environment_instance?.last_health_check?.status;

  if (!status || status === 'stopped') {
    return (
      <Tooltip title="Environment stopped">
        <MinusCircleOutlined style={{ color: token.colorTextDisabled }} />
      </Tooltip>
    );
  }

  if (status === 'starting' || status === 'stopping') {
    return (
      <Tooltip title={`Environment ${status}`}>
        <LoadingOutlined style={{ color: token.colorPrimary }} />
      </Tooltip>
    );
  }

  if (status === 'error') {
    return (
      <Tooltip
        title={`Error: ${branch.environment_instance?.last_health_check?.message || 'Unknown'}`}
      >
        <CloseCircleOutlined style={{ color: token.colorError }} />
      </Tooltip>
    );
  }

  if (status === 'running') {
    if (healthStatus === 'healthy') {
      return (
        <Tooltip title="Running (healthy)">
          <CheckCircleOutlined style={{ color: token.colorSuccess }} />
        </Tooltip>
      );
    }
    if (healthStatus === 'unhealthy') {
      return (
        <Tooltip
          title={`Running (unhealthy): ${branch.environment_instance?.last_health_check?.message || ''}`}
        >
          <WarningOutlined style={{ color: token.colorWarning }} />
        </Tooltip>
      );
    }
    return (
      <Tooltip title="Running">
        <Badge status="processing" />
      </Tooltip>
    );
  }

  return null;
}

/** Render the full Env cell (status icon + start/stop/open buttons) */
export function renderEnvCell(
  branch: Branch,
  repo: Repo | undefined,
  token: GlobalToken,
  callbacks: {
    onStartEnvironment?: (branchId: string) => void;
    onStopEnvironment?: (branchId: string) => void;
  }
) {
  const status = branch.environment_instance?.status;
  const healthStatus = branch.environment_instance?.last_health_check?.status;
  const effectiveEnv = repo ? getEffectiveEnv(repo) : undefined;
  const hasEnvConfig = !!effectiveEnv?.hasConfig;

  const isRunningOrHealthy =
    status === 'running' || status === 'starting' || healthStatus === 'healthy';

  // The "open health URL" button uses the branch's own `health_check_url`
  // (rendered at branch creation, then user-editable via the branch
  // modal) rather than re-rendering the repo template at click time. This
  // honours user edits and avoids a daemon round-trip.
  const healthUrl = branch.health_check_url;

  return (
    <Space size={4}>
      {renderEnvStatusIcon(branch, token)}
      {hasEnvConfig && repo && (
        <>
          <Button
            type="text"
            size="small"
            icon={<PlayCircleOutlined />}
            disabled={isRunningOrHealthy}
            onClick={(e) => {
              e.stopPropagation();
              callbacks.onStartEnvironment?.(branch.branch_id);
            }}
            style={{ padding: '0 4px' }}
          />
          <Button
            type="text"
            size="small"
            icon={<PoweroffOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              callbacks.onStopEnvironment?.(branch.branch_id);
            }}
            style={{ padding: '0 4px' }}
          />
          {healthUrl && (
            <Button
              type="text"
              size="small"
              icon={<GlobalOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                window.open(healthUrl, '_blank');
              }}
              style={{ padding: '0 4px' }}
            />
          )}
        </>
      )}
    </Space>
  );
}
