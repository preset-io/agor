import type { Branch, Repo, User } from '@agor-live/client';
import { Flex, theme } from 'antd';
import { OwnersTag } from '../metadata';
import { IssuePill, PullRequestPill } from '../Pill';

interface BranchMetadataRowProps {
  branch: Branch;
  repo?: Repo | null;
  /** Leading branch pill; renders first so the metadata links flow after it. */
  children: React.ReactNode;
  /** Current branch owners (from the owners API). */
  owners?: User[];
  /** Suppresses the owner tag when the sole owner is the current viewer. */
  currentUserId?: string;
  style?: React.CSSProperties;
}

/**
 * Single wrapping row for a branch pill and its metadata links: the pill owns
 * the leading slot, and owner/issue/PR links sit on the same line when
 * there is room, wrapping to the next line when there is not.
 */
export function BranchMetadataRow({
  branch,
  repo,
  children,
  owners,
  currentUserId,
  style,
}: BranchMetadataRowProps) {
  const { token } = theme.useToken();

  return (
    <Flex wrap gap={token.sizeUnit} align="center" style={style}>
      {children}
      {owners && owners.length > 0 && <OwnersTag owners={owners} currentUserId={currentUserId} />}
      {branch.issue_url && (
        <IssuePill issueUrl={branch.issue_url} currentRepo={repo ?? undefined} />
      )}
      {branch.pull_request_url && (
        <PullRequestPill prUrl={branch.pull_request_url} currentRepo={repo ?? undefined} />
      )}
    </Flex>
  );
}
