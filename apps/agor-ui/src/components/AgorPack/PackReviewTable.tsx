import {
  type AgorPackImport,
  agorPackArchivedNotes,
  agorPackOutsideLinksNote,
  pluralize,
} from '@agor/core/types';
import { Alert, Flex, Space, Table, Typography } from 'antd';
import { useMemo } from 'react';
import { Tag } from '../Tag';

type Row = AgorPackImport['manifest']['teammates'][number] & {
  dry: AgorPackImport['dry_run'][number] | undefined;
};

function contents(row: Row): string {
  const s = row.sections;
  return [
    s.board ? 'board' : null,
    s.knowledge ? pluralize(s.knowledge.documents, 'doc') : null,
    s.artifacts ? pluralize(s.artifacts, 'artifact') : null,
    s.schedules ? pluralize(s.schedules, 'schedule') : null,
    s.sessions ? pluralize(s.sessions.count, 'session') : null,
    s.uploads?.count ? pluralize(s.uploads.count, 'attachment') : null,
    s.claude_memory?.files ? 'Claude memory' : null,
    s.git ? (s.git.mode === 'bundle' ? 'full git tree' : 'git changes') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Already-imported teammates can't be imported twice; one whose file restore
 * failed stays selectable, and applying it again only retries the files.
 */
/** The teammate's imported branch, from the dry-run or from an apply since. */
export function importedBranchId(receipt: AgorPackImport, key: string): string | null {
  return (
    receipt.dry_run.find((d) => d.key === key)?.already_imported_branch_id ??
    receipt.results.find((r) => r.key === key)?.branch_id ??
    null
  );
}

export function locked(receipt: AgorPackImport, key: string): boolean {
  if (!importedBranchId(receipt, key)) return false;
  return receipt.results.find((r) => r.key === key)?.filesystem !== 'failed';
}

export interface PackReviewTableProps {
  receipt: AgorPackImport;
  selected: string[];
  onSelect: (keys: string[]) => void;
}

/** The dry-run review of an uploaded pack: what each teammate brings, and what needs attention. */
export const PackReviewTable: React.FC<PackReviewTableProps> = ({
  receipt,
  selected,
  onSelect,
}) => {
  const rows: Row[] = useMemo(
    () =>
      receipt.manifest.teammates.map((teammate) => ({
        ...teammate,
        dry: receipt.dry_run.find((d) => d.key === teammate.key),
      })),
    [receipt]
  );
  return (
    <Flex vertical gap="middle">
      <Table<Row>
        size="small"
        rowKey="key"
        pagination={false}
        dataSource={rows}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => onSelect(keys as string[]),
          getCheckboxProps: (row) => ({
            disabled: locked(receipt, row.key),
            'aria-label': `Import ${row.display_name}`,
          }),
        }}
        columns={[
          {
            title: 'Teammate',
            key: 'teammate',
            render: (_: unknown, row) => (
              <Space orientation="vertical" size={0}>
                <Typography.Text strong>
                  {row.emoji ?? '🤖'} {row.display_name}
                </Typography.Text>
                <Typography.Text type="secondary">{contents(row)}</Typography.Text>
                {[
                  ...agorPackArchivedNotes(row.sections.archived_skipped),
                  agorPackOutsideLinksNote(row.sections.knowledge?.outside_links),
                ]
                  .filter((note): note is string => Boolean(note))
                  .map((note) => (
                    <Typography.Text key={note} type="secondary">
                      {note}
                    </Typography.Text>
                  ))}
              </Space>
            ),
          },
          {
            title: 'Repository',
            key: 'repo',
            width: 180,
            render: (_: unknown, row) =>
              importedBranchId(receipt, row.key) ? (
                locked(receipt, row.key) ? (
                  <Tag color="success">already imported</Tag>
                ) : (
                  <Tag color="warning">files failed: select to retry</Tag>
                )
              ) : (
                <Space orientation="vertical" size={0}>
                  <Typography.Text>{row.repo.slug}</Typography.Text>
                  <Tag>
                    {row.dry?.repo_status === 'existing'
                      ? 'already here'
                      : row.dry?.repo_status === 'framework'
                        ? 'teammate framework'
                        : 'will clone'}
                  </Tag>
                </Space>
              ),
          },
          {
            title: 'Needs attention',
            key: 'warnings',
            render: (_: unknown, row) => (
              <Flex vertical gap={2}>
                {row.requirements.env_vars.length > 0 && (
                  <span>{pluralize(row.requirements.env_vars.length, 'environment variable')}</span>
                )}
                {(row.dry?.warnings ?? []).map((warning) => (
                  <Typography.Text key={warning} type="warning">
                    {warning}
                  </Typography.Text>
                ))}
              </Flex>
            ),
          },
        ]}
      />
      {rows.some((row) => importedBranchId(receipt, row.key)) && (
        <Alert
          type="info"
          showIcon
          message="Teammates you already imported from this file are skipped."
        />
      )}
    </Flex>
  );
};
