import type { Branch, Repo, User } from '@agor-live/client';
import { Flex, theme } from 'antd';
import { CreatedByTag } from '../metadata';
import { IssuePill, PullRequestPill } from '../Pill';

interface BranchMetadataRowProps {
  branch: Branch;
  repo?: Repo | null;
  /** Leading branch pill; renders first so the metadata links flow after it. */
  children: React.ReactNode;
  /** Users map enabling the "Created by" tag when the branch has a creator. */
  userById?: Map<string, User>;
  /** Suppresses the "Created by" tag for the viewer's own branches. */
  currentUserId?: string;
  style?: React.CSSProperties;
}

/**
 * Single wrapping row for a branch pill and its metadata links: the pill owns
 * the leading slot, and created-by/issue/PR links sit on the same line when
 * there is room, wrapping to the next line when there is not.
 */
export function BranchMetadataRow({
  branch,
  repo,
  children,
  userById,
  currentUserId,
  style,
}: BranchMetadataRowProps) {
  const { token } = theme.useToken();

  return (
    <Flex wrap gap={token.sizeUnit} align="center" style={style}>
      {children}
      {branch.created_by && userById && (
        <CreatedByTag
          createdBy={branch.created_by}
          currentUserId={currentUserId}
          userById={userById}
          prefix="Created by"
        />
      )}
      {branch.issue_url && (
        <IssuePill issueUrl={branch.issue_url} currentRepo={repo ?? undefined} />
      )}
      {branch.pull_request_url && (
        <PullRequestPill prUrl={branch.pull_request_url} currentRepo={repo ?? undefined} />
      )}
    </Flex>
  );
}
