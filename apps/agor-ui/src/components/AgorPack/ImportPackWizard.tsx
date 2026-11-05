import { type AgorPackImport, pluralize } from '@agor/core/types';
import type { AgorClient, Board, User } from '@agor-live/client';
import { InboxOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Progress, Select, Spin, Steps, Typography, Upload } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { applyPackImport, getPackImport, uploadPack } from '../../utils/agorPack';
import { useThemedMessage } from '../../utils/message';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';
import { locked, PackReviewTable } from './PackReviewTable';
import { ReconnectChecklist } from './ReconnectChecklist';

export interface ImportPackWizardProps {
  open: boolean;
  onClose: () => void;
  client?: AgorClient | null;
  currentUser?: User | null;
  boardById: Map<string, Board>;
  /** Start on the review step for an already-uploaded pack (tests). */
  initialReceipt?: AgorPackImport;
  /** Open the reconnect checklist of an import that already ran (`?import=<id>`). */
  importId?: string;
}

export const ImportPackWizard: React.FC<ImportPackWizardProps> = ({
  open,
  onClose,
  client,
  currentUser,
  boardById,
  initialReceipt,
  importId,
}) => {
  const { showError, showSuccess } = useThemedMessage();
  const [receipt, setReceipt] = useState<AgorPackImport | null>(initialReceipt ?? null);
  const [step, setStep] = useState(initialReceipt ? 1 : importId ? 2 : 0);
  const [progress, setProgress] = useState<number | null>(null);
  const [selected, setSelected] = useState<string[]>(
    () => initialReceipt?.manifest.teammates.map((t) => t.key) ?? []
  );
  const [boardId, setBoardId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!importId) return;
    let cancelled = false;
    getPackImport(importId)
      .then((result) => {
        if (cancelled) return;
        lastStatus.current = result.status;
        setReceipt(result);
        setSelected(result.manifest.teammates.map((t) => t.key));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        showError(error instanceof Error ? error.message : String(error));
        setStep(0);
      });
    return () => {
      cancelled = true;
    };
  }, [importId, showError]);

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
            <PackReviewTable receipt={receipt} selected={selected} onSelect={setSelected} />
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
          </Flex>
        )}

        {step === 2 && !receipt && <Spin />}
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
