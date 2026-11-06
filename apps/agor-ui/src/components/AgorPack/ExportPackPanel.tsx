import {
  AGOR_PACK_DEFAULT_SESSION_MODE,
  type AgorPackPreflightTeammate,
  type AgorPackSessionMode,
  agorPackArchivedNotes,
  agorPackOutsideLinksNote,
} from '@agor/core/types';
import type { Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { DownloadOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Flex, Form, Select, Skeleton, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AgorPackExportResult, exportPack, fetchPackPreflight } from '../../utils/agorPack';
import { useThemedMessage } from '../../utils/message';
import { CheckReport } from './CheckReport';
import { checkFromPreflight, exportEstimate } from './packCheck';
import { countLabel, fill, megabytes, PACK_COPY } from './packCopy';
import { SessionHistoryPicker } from './SessionHistoryPicker';

/**
 * Preflight of the chosen teammates. Null while loading and after a failure
 * (with `error`): nothing may be exported from a check that didn't run.
 */
export function usePackPreflight(branchIds: string[]): {
  preflight: AgorPackPreflightTeammate[] | null;
  error: string | null;
  retry: () => void;
} {
  const [preflight, setPreflight] = useState<AgorPackPreflightTeammate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = branchIds.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the preflight
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    setError(null);
    if (ids.length === 0) {
      setPreflight([]);
      return;
    }
    let cancelled = false;
    setPreflight(null);
    fetchPackPreflight(ids)
      .then((result) => !cancelled && setPreflight(result))
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { preflight, error, retry };
}

/** The preflight's failure, with Retry. */
export const PreflightError: React.FC<{ error: string; onRetry: () => void }> = ({
  error,
  onRetry,
}) => (
  <Alert
    type="error"
    showIcon
    message={`Couldn't check what moves: ${error}`}
    action={
      <Button size="small" onClick={onRetry}>
        {PACK_COPY.progRetry}
      </Button>
    }
  />
);

/** Archived/private rows left behind and Knowledge links kept as-is, per teammate. */
export function preflightNotes(teammate: AgorPackPreflightTeammate, mode: AgorPackSessionMode) {
  return [
    ...teammate.warnings.filter((warning) => /board/i.test(warning)),
    ...agorPackArchivedNotes({
      ...teammate.archived,
      sessions: mode === 'none' ? 0 : teammate.archived.sessions,
    }),
    agorPackOutsideLinksNote(teammate.knowledge_outside_links),
  ].filter((note): note is string => Boolean(note));
}

export interface ExportPackPanelProps {
  teammates: Branch[];
  initialBranchIds: string[];
  /** Called after the file downloaded (or, with `download: false`, was staged). */
  onExported?: (result: AgorPackExportResult) => void | Promise<void>;
  exportLabel?: string;
  /** False: build the pack on the daemon without downloading it. */
  download?: boolean;
  exportIcon?: React.ReactNode;
}

/**
 * Choose and check: teammates, session history, then the Check report.
 * Everything else (board, artifacts, Knowledge, schedules, memory, skills,
 * attachments) always moves.
 */
export const ExportPackPanel: React.FC<ExportPackPanelProps> = ({
  teammates,
  initialBranchIds,
  onExported,
  exportLabel = PACK_COPY.expBtn,
  download = true,
  exportIcon = <DownloadOutlined />,
}) => {
  const { showError, showSuccess } = useThemedMessage();
  const [branchIds, setBranchIds] = useState<string[]>(initialBranchIds);
  const [sessions, setSessions] = useState<AgorPackSessionMode>(AGOR_PACK_DEFAULT_SESSION_MODE);
  const [includeOthers, setIncludeOthers] = useState(false);
  const [leaveOut, setLeaveOut] = useState(true);
  const [exporting, setExporting] = useState(false);
  const { preflight, error, retry } = usePackPreflight(branchIds);
  const others = sessions !== 'none' && includeOthers;

  const options = useMemo(
    () =>
      teammates.map((branch) => {
        const config = getTeammateConfig(branch);
        return {
          value: branch.branch_id,
          label: `${config?.emoji ?? '🤖'} ${config?.displayName ?? branch.name}`,
        };
      }),
    [teammates]
  );
  const check = preflight ? checkFromPreflight(preflight, sessions, others, leaveOut) : null;
  const estimate = preflight ? exportEstimate(preflight, sessions, others) : null;
  const othersCount = (preflight ?? []).reduce(
    (sum, t) => sum + (sessions === 'all' ? t.sessions.others : t.sessions.recent_others),
    0
  );

  const handleExport = async () => {
    // Never export without a completed check (its exclusions apply).
    if (!check) return;
    setExporting(true);
    try {
      const result = await exportPack(
        {
          branch_ids: branchIds,
          sessions,
          include_others_sessions: others,
          exclude_session_ids: leaveOut ? (check?.flagged ?? []).map((s) => s.session_id) : [],
        },
        { download }
      );
      if (download) showSuccess(fill(PACK_COPY.expToast, { file: result.filename }));
      await onExported?.(result);
    } catch (reason) {
      showError(`Export failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Flex vertical gap="middle">
      <Form layout="vertical" requiredMark={false}>
        <Form.Item label={PACK_COPY.tmLabel}>
          <Select
            mode="multiple"
            value={branchIds}
            onChange={setBranchIds}
            options={options}
            aria-label="Teammates to export"
          />
        </Form.Item>
        <SessionHistoryPicker
          value={sessions}
          onChange={setSessions}
          preflight={preflight}
          includeOthers={others}
        />
        <Checkbox
          style={{ marginTop: 8 }}
          checked={others}
          disabled={sessions === 'none'}
          onChange={(event) => setIncludeOthers(event.target.checked)}
        >
          Include other people's sessions{othersCount > 0 ? ` (${othersCount})` : ''}
        </Checkbox>
      </Form>

      <Flex vertical gap={8}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {PACK_COPY.checkTitle}
        </Typography.Title>
        {error ? (
          <PreflightError error={error} onRetry={retry} />
        ) : check ? (
          <CheckReport
            check={check}
            mode="move"
            leaveOut={leaveOut}
            onLeaveOutChange={setLeaveOut}
          />
        ) : (
          <Skeleton active paragraph={{ rows: 3 }} />
        )}
        {(preflight ?? []).flatMap((teammate) =>
          preflightNotes(teammate, sessions).map((note) => (
            <Typography.Text key={`${teammate.branch_id}:${note}`} type="secondary">
              {teammate.display_name}: {note}
            </Typography.Text>
          ))
        )}
        <Typography.Text type="secondary">
          <InfoCircleOutlined /> {PACK_COPY.checkFoot}
        </Typography.Text>
      </Flex>

      <Flex justify="space-between" align="center" gap={8} wrap>
        <Typography.Text type="secondary">
          {estimate &&
            fill(PACK_COPY.chooseTotal, {
              n: branchIds.length,
              teammates: countLabel(
                branchIds.length,
                PACK_COPY.cntTeammate,
                PACK_COPY.cntTeammates
              ),
              mb: megabytes(estimate.bytes),
            })}
        </Typography.Text>
        <Button
          type="primary"
          icon={exportIcon}
          loading={exporting}
          disabled={branchIds.length === 0 || preflight === null}
          onClick={handleExport}
        >
          {exportLabel}
        </Button>
      </Flex>
    </Flex>
  );
};
