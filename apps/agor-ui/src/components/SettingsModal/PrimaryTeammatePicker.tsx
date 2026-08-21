import type { AgorClient, Board, Branch, Repo } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { RobotOutlined } from '@ant-design/icons';
import { App as AntApp, Select, Space, Spin, Typography } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectRepoById } from '../../store/selectors';

interface PrimaryTeammatePickerProps {
  client: AgorClient | null;
  /** Caller identity; changing it invalidates all caller-scoped cached data. */
  currentUserId?: string;
  /** Drop the heading/description chrome for embedding in a tight surface (e.g. a popover). */
  compact?: boolean;
  disabled?: boolean;
  /** Fired after a successful pick so an embedder can continue an in-flight action. */
  onPicked?: (branch: Branch) => void;
}

interface TeammateOption {
  value: string;
  label: string;
  context: string;
  searchText: string;
}

function teammateLabel(branch: Branch): string {
  return getTeammateConfig(branch)?.displayName ?? branch.name;
}

/** Where the teammate lives — its board, falling back to the repo slug. */
function teammateContext(
  branch: Branch,
  boardById: Map<string, Board>,
  repoById: Map<string, Repo>
): string {
  const board = branch.board_id ? boardById.get(branch.board_id) : undefined;
  if (board) return `${board.icon ?? '📋'} ${board.name}`;
  return repoById.get(branch.repo_id)?.slug ?? 'Unknown board';
}

/**
 * Self-contained picker for the calling user's primary assistant — the default
 * teammate for personal/ambient work. Reads and writes via the caller-scoped
 * `users.getPrimaryTeammate` / `users.setPrimaryTeammate` RPCs; no assumptions
 * about the surrounding modal so it can be relocated by moving its mount point.
 */
export const PrimaryTeammatePicker: React.FC<PrimaryTeammatePickerProps> = ({
  client,
  currentUserId,
  compact = false,
  disabled = false,
  onPicked,
}) => {
  const { message } = AntApp.useApp();
  const boardById = useAgorStore(selectBoardById);
  const repoById = useAgorStore(selectRepoById);

  const [current, setCurrent] = useState<Branch | null>(null);
  const [candidates, setCandidates] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: caller identity invalidates caller-scoped RPC results even when the client instance is reused
  useEffect(() => {
    if (!client) {
      setCurrent(null);
      setCandidates([]);
      setLoading(false);
      setLoadFailed(true);
      return;
    }
    let cancelled = false;
    setCurrent(null);
    setCandidates([]);
    setLoading(true);
    setLoadFailed(false);
    Promise.all([
      client.service('users').getPrimaryTeammate(),
      client.service('users').getPrimaryTeammateCandidates(),
    ])
      .then(([branch, eligibleCandidates]) => {
        if (!cancelled) {
          setCurrent(branch && isTeammate(branch) && !branch.archived ? branch : null);
          setCandidates(eligibleCandidates);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, currentUserId]);

  const options = useMemo<TeammateOption[]>(() => {
    const teammates = candidates.slice();
    // The resolved primary may live on a board this list doesn't otherwise
    // surface; keep it selectable so its label renders instead of a raw id.
    if (current && !teammates.some((branch) => branch.branch_id === current.branch_id)) {
      teammates.push(current);
    }
    return teammates
      .sort((a, b) => teammateLabel(a).localeCompare(teammateLabel(b)))
      .map((branch) => {
        const label = teammateLabel(branch);
        const context = teammateContext(branch, boardById, repoById);
        return {
          value: branch.branch_id,
          label,
          context,
          searchText: `${label} ${branch.name} ${context}`,
        };
      });
  }, [candidates, boardById, repoById, current]);

  const handleChange = async (branchId: string) => {
    if (!client) return;
    setSaving(true);
    try {
      const branch = await client.service('users').setPrimaryTeammate({ branchId });
      setCurrent(branch);
      if (branch) {
        message.success(`Primary assistant set to ${teammateLabel(branch)}`);
        onPicked?.(branch);
      }
    } catch (error) {
      message.error(
        `Failed to update primary assistant: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {!compact && (
        <Typography.Text type="secondary">
          Your default teammate for personal, ambient work. Change it anytime.
        </Typography.Text>
      )}

      {loading ? (
        <Spin />
      ) : loadFailed ? (
        <Typography.Text type="danger">
          Couldn't load your primary assistant. Check the connection and try again.
        </Typography.Text>
      ) : current ? (
        <Typography.Text>
          Currently <Typography.Text strong>{teammateLabel(current)}</Typography.Text> on{' '}
          {teammateContext(current, boardById, repoById)}.
        </Typography.Text>
      ) : compact ? null : (
        <Typography.Text type="secondary">
          No primary assistant set — pick one below to use as your default for personal work.
        </Typography.Text>
      )}

      <Select
        showSearch
        loading={saving}
        disabled={disabled || saving || !client || loadFailed}
        placeholder="Select a primary assistant"
        value={current?.branch_id}
        onChange={handleChange}
        options={options}
        optionFilterProp="searchText"
        notFoundContent={options.length === 0 ? 'No teammates available' : undefined}
        suffixIcon={<RobotOutlined />}
        style={{ width: '100%', maxWidth: 420 }}
        optionRender={(option) => (
          <div style={{ lineHeight: 1.3 }}>
            <div>{option.data.label}</div>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {option.data.context}
            </Typography.Text>
          </div>
        )}
      />
    </Space>
  );
};
