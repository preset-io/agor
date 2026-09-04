import { Alert, Checkbox, Flex, Typography } from 'antd';
import type { SessionArchiveOutcome } from '../../hooks/useSessionActions';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

interface SessionArchiveConfirmContentProps {
  /** Dry-run result for the same request the confirmation will send. */
  preview: SessionArchiveOutcome;
  /** Initial state of the remote-children choice. Default: true. */
  defaultIncludeRemoteChildren?: boolean;
  onIncludeRemoteChildrenChange: (includeRemoteChildren: boolean) => void;
}

/**
 * Body of the archive confirmation. The remote default is deliberate but must
 * never be invisible: the user sees the counts a dry-run produced and can
 * uncheck the remote choice before confirming.
 */
export function SessionArchiveConfirmContent({
  preview,
  defaultIncludeRemoteChildren = true,
  onIncludeRemoteChildrenChange,
}: SessionArchiveConfirmContentProps) {
  const remoteBranches = new Set(
    preview.units
      .filter((unit) => unit.kind === 'remote' && unit.status !== 'skipped')
      .map((unit) => unit.branchId)
  ).size;
  return (
    <Flex vertical gap="small">
      <Typography.Text>
        This archives {plural(preview.localCount, 'session')} in this branch. Archiving hides
        sessions from listings; it does not stop running work.
      </Typography.Text>
      <Checkbox
        defaultChecked={defaultIncludeRemoteChildren}
        onChange={(event) => onIncludeRemoteChildrenChange(event.target.checked)}
      >
        Also archive {plural(preview.remoteCount, 'session')} this one created in{' '}
        {plural(remoteBranches, 'other branch')}
      </Checkbox>
      {preview.runningCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${plural(preview.runningCount, 'session')} still running will be hidden but keep working.`}
        />
      )}
      {preview.skippedCount > 0 && (
        <Alert
          type="info"
          showIcon
          message={`${plural(preview.skippedCount, 'remote session')} in branches you cannot modify will be left unchanged.`}
        />
      )}
      {preview.limitExceeded && (
        <Alert
          type="error"
          showIcon
          message="Too many sessions in other branches to archive at once. Uncheck the remote option or archive them separately."
        />
      )}
    </Flex>
  );
}

/** User-facing copy for a dedicated archive/unarchive outcome. */
export function formatSessionArchiveOutcome(
  outcome: SessionArchiveOutcome,
  verb: 'Archived' | 'Restored' = 'Archived'
): { success: string; warning?: string } {
  const total = verb === 'Archived' ? outcome.archivedCount : outcome.unarchivedCount;
  const success =
    outcome.remoteCount > 0
      ? `${verb} ${plural(total, 'session')} (${outcome.localCount} in this branch, ${outcome.remoteCount} in other branches)`
      : `${verb} ${plural(total, 'session')}`;
  const warnings: string[] = [];
  if (outcome.skippedCount > 0) {
    warnings.push(
      `${plural(outcome.skippedCount, 'remote session')} skipped: you do not have permission in that branch, so they were left unchanged.`
    );
  }
  if (verb === 'Restored' && outcome.remainingArchived.length > 0) {
    warnings.push(
      `${plural(outcome.remainingArchived.length, 'child session')} stayed archived because of an independent reason, another archived parent, or an archived branch.`
    );
  }
  return { success, warning: warnings.length > 0 ? warnings.join(' ') : undefined };
}

/**
 * True when the daemon refused the local unit because the caller lacks prompt
 * permission for a child (session-tier callers on shared sessions). The
 * caller can retry with `includeChildren: false` for its own root.
 */
export function isArchivePermissionDenial(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /need 'prompt' permission/i.test(message);
}
