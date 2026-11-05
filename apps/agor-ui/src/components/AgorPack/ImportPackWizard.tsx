import {
  type AgorPackImport,
  agorPackArchivedNotes,
  agorPackOutsideLinksNote,
  pluralize,
} from '@agor/core/types';
import type { AgorClient, Board, User } from '@agor-live/client';
import { InboxOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Flex,
  Progress,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Typography,
  Upload,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { applyPackImport, getPackImport, uploadPack } from '../../utils/agorPack';
import { useThemedMessage } from '../../utils/message';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';
import { Tag } from '../Tag';
import { ReconnectChecklist } from './ReconnectChecklist';

export interface ImportPackWizardProps {
  open: boolean;
  onClose: () => void;
  client?: AgorClient | null;
  currentUser?: User | null;
  boardById: Map<string, Board>;
  /** Start on the review step for an already-uploaded pack (tests). */
  initialReceipt?: AgorPackImport;
}

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
function locked(receipt: AgorPackImport, key: string): boolean {
  const imported = receipt.dry_run.find((d) => d.key === key)?.already_imported_branch_id;
  if (!imported) return false;
  return receipt.results.find((r) => r.key === key)?.filesystem !== 'failed';
}

export const ImportPackWizard: React.FC<ImportPackWizardProps> = ({
  open,
  onClose,
  client,
  currentUser,
  boardById,
  initialReceipt,
}) => {
  const { showError, showSuccess } = useThemedMessage();
  const [receipt, setReceipt] = useState<AgorPackImport | null>(initialReceipt ?? null);
  const [step, setStep] = useState(initialReceipt ? 1 : 0);
  const [progress, setProgress] = useState<number | null>(null);
  const [selected, setSelected] = useState<string[]>(
    () => initialReceipt?.manifest.teammates.map((t) => t.key) ?? []
  );
  const [boardId, setBoardId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Apply (rows, then files) runs in the background; follow the receipt until done.
  const busy =
    receipt?.status === 'applying' ||
    (receipt?.results.some((r) => r.filesystem === 'pending') ?? false);
  const lastStatus = useRef(receipt?.status);
  useEffect(() => {
    if (!receipt || step !== 2 || !busy) return;
    const timer = setInterval(() => {
      getPackImport(receipt.import_id)
        .then(setReceipt)
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [receipt, step, busy]);
  useEffect(() => {
    if (lastStatus.current === 'applying' && receipt?.status === 'applied') {
      showSuccess(`Imported ${pluralize(receipt.results.length, 'teammate')}`);
    }
    lastStatus.current = receipt?.status;
  }, [receipt, showSuccess]);

  const rows: Row[] = useMemo(
    () =>
      (receipt?.manifest.teammates ?? []).map((teammate) => ({
        ...teammate,
        dry: receipt?.dry_run.find((d) => d.key === teammate.key),
      })),
    [receipt]
  );

  const handleFile = async (file: File) => {
    setProgress(0);
    try {
      const result = await uploadPack(file, setProgress);
      setReceipt(result);
      setSelected(result.dry_run.filter((d) => !locked(result, d.key)).map((d) => d.key));
      setStep(1);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setProgress(null);
    }
  };

  const handleApply = async () => {
    if (!receipt) return;
    setApplying(true);
    try {
      const result = await applyPackImport(receipt.import_id, {
        teammates: selected,
        board_id: boardId,
      });
      lastStatus.current = result.status;
      setReceipt(result);
      setStep(2);
    } catch (error) {
      showError(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setApplying(false);
    }
  };

  const source = receipt?.manifest.source;

  return (
    <AdaptiveSettingsModal
      title="Import teammates (.agorpack)"
      open={open}
      onCancel={onClose}
      width={880}
      destroyOnHidden
      footer={
        step === 1 ? (
          <Flex justify="flex-end" gap={8}>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="primary"
              loading={applying}
              disabled={selected.length === 0}
              onClick={handleApply}
            >
              Import {pluralize(selected.length, 'teammate')}
            </Button>
          </Flex>
        ) : step === 2 ? (
          <Flex justify="flex-end">
            <Button type="primary" onClick={onClose}>
              Done
            </Button>
          </Flex>
        ) : null
      }
    >
      <Flex vertical gap="large">
        <Steps
          size="small"
          current={step}
          items={[{ title: 'Upload' }, { title: 'Review' }, { title: 'Reconnect' }]}
        />

        {step === 0 && (
          <Flex vertical gap="small">
            <Upload.Dragger
              accept=".agorpack,application/zip"
              multiple={false}
              showUploadList={false}
              disabled={progress !== null}
              beforeUpload={(file) => {
                void handleFile(file);
                return false;
              }}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">Drop a .agorpack file here, or click to choose one</p>
              <p className="ant-upload-hint">
                Nothing is imported until you review the contents on the next step.
              </p>
            </Upload.Dragger>
            {progress !== null && <Progress percent={progress} status="active" />}
          </Flex>
        )}

        {step === 1 && receipt && (
          <Flex vertical gap="middle">
            <Typography.Text type="secondary">
              Exported from Agor {source?.agor_version}
              {source?.exported_by.name ? ` by ${source.exported_by.name}` : ''} on{' '}
              {new Date(receipt.manifest.created_at).toLocaleString()}. You will own everything
              imported; schedules arrive paused.
            </Typography.Text>
            <Table<Row>
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={rows}
              rowSelection={{
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys as string[]),
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
                    row.dry?.already_imported_branch_id ? (
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
                        <span>
                          {pluralize(row.requirements.env_vars.length, 'environment variable')}
                        </span>
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
            <Flex align="center" gap={8} wrap>
              <Typography.Text>Place on</Typography.Text>
              <Select
                style={{ minWidth: 260 }}
                value={boardId ?? 'new'}
                aria-label="Board"
                onChange={(value) => setBoardId(value === 'new' ? null : value)}
                options={[
                  { value: 'new', label: 'A new board per teammate (from the pack)' },
                  ...[...boardById.values()]
                    .filter((board) => !board.archived)
                    .map((board) => ({ value: board.board_id, label: board.name })),
                ]}
              />
            </Flex>
            {rows.some((row) => row.dry?.already_imported_branch_id) && (
              <Alert
                type="info"
                showIcon
                message="Teammates you already imported from this file are skipped."
              />
            )}
          </Flex>
        )}

        {step === 2 && receipt?.status === 'applying' && (
          <Alert
            type="info"
            showIcon
            icon={<Spin size="small" />}
            message={`Importing… ${receipt.results.length} of ${pluralize(selected.length, 'teammate')} done`}
          />
        )}
        {step === 2 && receipt?.status === 'failed' && (
          <Alert
            type="error"
            showIcon
            message="The import stopped part-way"
            description={`${receipt.error ?? 'Unknown error'}. Resuming continues where it stopped; nothing is imported twice.`}
            action={
              <Button size="small" loading={applying} onClick={handleApply}>
                Resume
              </Button>
            }
          />
        )}
        {step === 2 && receipt && (
          <ReconnectChecklist
            client={client}
            currentUser={currentUser}
            receipt={receipt}
            onReceipt={setReceipt}
          />
        )}
      </Flex>
    </AdaptiveSettingsModal>
  );
};
