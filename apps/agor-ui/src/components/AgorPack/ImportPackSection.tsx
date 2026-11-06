import {
  AGOR_PACK,
  type AgorPackImport,
  agorPackArchivedNotes,
  agorPackOutsideLinksNote,
} from '@agor/core/types';
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  FileZipOutlined,
  InboxOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { Alert, Button, Checkbox, Flex, Progress, Typography, theme, Upload } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { applyPackImport, getPackImport, uploadPack } from '../../utils/agorPack';
import { useThemedMessage } from '../../utils/message';
import { ResponsiveSettingsHeader } from '../SettingsModal/ResponsiveSettingsHeader';
import { Tag } from '../Tag';
import { CheckReport } from './CheckReport';
import { checkFromReceipt } from './packCheck';
import { fill, megabytes, PACK_COPY } from './packCopy';

export interface ImportPackSectionProps {
  /** Self-hosted installs say where packs usually come from differently. */
  selfHosted: boolean;
  /** Closes Settings before opening an imported teammate's board. */
  onClose?: () => void;
}

/** "Ada", "Ada and Wendy", "Ada, Wendy and Blake". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A teammate already imported from this file can't be imported twice; one
 * whose file restore failed stays selectable (applying again only retries it).
 */
function locked(receipt: AgorPackImport, key: string): boolean {
  const imported = receipt.dry_run.find((d) => d.key === key)?.already_imported_branch_id;
  if (!imported) return false;
  return receipt.results.find((r) => r.key === key)?.filesystem !== 'failed';
}

type Stage = 'drop' | 'upload' | 'check' | 'import';

/** Settings → System → Import: drop an .agor file, check it, import it. */
export const ImportPackSection: React.FC<ImportPackSectionProps> = ({ selfHosted, onClose }) => {
  const { token } = theme.useToken();
  const navigation = useAppNavigation();
  // Its board shows Finish setup.
  const onOpenTeammate = (branchId: string) => {
    onClose?.();
    navigation.goToBranch(branchId);
  };
  const { showError } = useThemedMessage();
  const [searchParams] = useSearchParams();
  const [stage, setStage] = useState<Stage>('drop');
  const [file, setFile] = useState<File | null>(null);
  const [percent, setPercent] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AgorPackImport | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [skipFlagged, setSkipFlagged] = useState(true);
  const [applying, setApplying] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // `?import=<import id>` reopens a receipt (e.g. after an import started elsewhere).
  const deepLink = searchParams.get('import');
  useEffect(() => {
    if (!deepLink || deepLink === '1') return;
    let cancelled = false;
    getPackImport(deepLink)
      .then((loaded) => {
        if (cancelled) return;
        setReceipt(loaded);
        setSelected(loaded.results.map((r) => r.key));
        setStage(loaded.status === 'staged' ? 'check' : 'import');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [deepLink]);
  useEffect(() => () => abort.current?.abort(), []);

  // Apply runs in the background; follow the receipt until rows and files are done.
  const busy =
    receipt?.status === 'applying' ||
    (receipt?.results.some((r) => r.filesystem === 'pending') ?? false);
  useEffect(() => {
    if (!receipt || stage !== 'import' || !busy) return;
    const timer = setInterval(() => {
      getPackImport(receipt.import_id)
        .then(setReceipt)
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [receipt, stage, busy]);

  const upload = async (next: File) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setFile(next);
    setStage('upload');
    setPercent(0);
    setUploadError(null);
    try {
      const result = await uploadPack(
        next,
        // Hashing the file is the first tenth of the bar.
        (value, phase) =>
          setPercent(phase === 'checking' ? Math.floor(value / 10) : 10 + Math.floor(value * 0.9)),
        controller.signal
      );
      setReceipt(result);
      setSelected(result.dry_run.filter((d) => !locked(result, d.key)).map((d) => d.key));
      setStage('check');
    } catch (error) {
      if (controller.signal.aborted) return;
      setUploadError(error instanceof Error ? error.message : String(error));
    }
  };

  const reset = () => {
    abort.current?.abort();
    setStage('drop');
    setFile(null);
    setReceipt(null);
    setUploadError(null);
  };

  const apply = async (keys: string[]) => {
    if (!receipt) return;
    setApplying(true);
    try {
      setReceipt(
        await applyPackImport(receipt.import_id, {
          teammates: keys,
          board_id: null,
          skip_flagged_sessions: skipFlagged,
        })
      );
      setStage('import');
    } catch (error) {
      showError(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setApplying(false);
    }
  };

  const fileChip = (detail: React.ReactNode, action?: React.ReactNode) => (
    <Flex
      align="center"
      gap={8}
      style={{
        padding: '8px 12px',
        borderRadius: token.borderRadius,
        background: token.colorFillQuaternary,
      }}
    >
      <FileZipOutlined />
      <Typography.Text code>{file?.name ?? `teammates${AGOR_PACK.extension}`}</Typography.Text>
      <Typography.Text type="secondary" style={{ flex: 1 }}>
        {detail}
      </Typography.Text>
      {action}
    </Flex>
  );
  const removeLink = (
    <Typography.Link onClick={reset} disabled={applying}>
      {PACK_COPY.impRemove}
    </Typography.Link>
  );

  const teammates = receipt?.manifest.teammates ?? [];
  const chosen = teammates.filter((t) => selected.includes(t.key));
  const names = joinNames(chosen.map((t) => t.display_name));

  return (
    <div>
      <ResponsiveSettingsHeader
        title={PACK_COPY.impHead}
        description={selfHosted ? PACK_COPY.impLeadCe : PACK_COPY.impLead}
      />
      <Flex vertical gap="middle" style={{ maxWidth: 720 }}>
        {stage === 'drop' && (
          <Upload.Dragger
            accept={`${AGOR_PACK.extension},.agorpack,application/zip`}
            multiple={false}
            showUploadList={false}
            beforeUpload={(next) => {
              if (next.size > AGOR_PACK.maxBytes) {
                showError(PACK_COPY.impDropSub);
              } else {
                void upload(next);
              }
              return false;
            }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">{PACK_COPY.impDrop}</p>
            <p className="ant-upload-hint">{PACK_COPY.impDropSub}</p>
          </Upload.Dragger>
        )}

        {stage === 'upload' && (
          <Flex vertical gap={8}>
            {fileChip(file ? `${megabytes(file.size)} MB` : null, removeLink)}
            <Progress percent={percent} status={uploadError ? 'exception' : 'active'} />
            {uploadError && (
              <Alert
                type="error"
                showIcon
                message={uploadError}
                action={
                  <Button size="small" onClick={() => file && upload(file)}>
                    {PACK_COPY.progRetry}
                  </Button>
                }
              />
            )}
          </Flex>
        )}

        {stage === 'check' && receipt && (
          <Flex vertical gap="middle">
            {fileChip(
              `${file ? `${megabytes(file.size)} MB · ` : ''}Agor ${receipt.manifest.source.agor_version}`,
              removeLink
            )}
            <Typography.Title level={5} style={{ margin: 0 }}>
              {PACK_COPY.impCheck}
            </Typography.Title>
            {teammates.length > 1 && (
              <Checkbox.Group
                value={selected}
                onChange={(keys) => setSelected(keys as string[])}
                options={teammates.map((t) => ({
                  value: t.key,
                  label: `${t.emoji ?? '🤖'} ${t.display_name}`,
                  disabled: locked(receipt, t.key),
                }))}
              />
            )}
            <CheckReport
              check={checkFromReceipt(receipt, selected, skipFlagged)}
              mode="import"
              leaveOut={skipFlagged}
              onLeaveOutChange={setSkipFlagged}
            />
            {chosen.flatMap((teammate) =>
              [
                ...(receipt.dry_run.find((d) => d.key === teammate.key)?.warnings ?? []).filter(
                  // Environment problems are in "Won't work in Agor Cloud yet".
                  (warning) => !warning.startsWith('Environment "')
                ),
                ...agorPackArchivedNotes(teammate.sections.archived_skipped),
                agorPackOutsideLinksNote(teammate.sections.knowledge?.outside_links),
              ]
                .filter((note): note is string => Boolean(note))
                .map((note) => (
                  <Typography.Text key={`${teammate.key}:${note}`} type="secondary">
                    {teammate.display_name}: {note}
                  </Typography.Text>
                ))
            )}
            {receipt.dry_run
              .filter((d) => selected.includes(d.key) && d.already_imported_branch_id)
              .map((d) => (
                <Alert
                  key={d.key}
                  type="info"
                  showIcon
                  message={`${d.display_name} was already imported from this file; importing again retries its files.`}
                />
              ))}
            {names && (
              <Alert type="info" showIcon message={fill(PACK_COPY.impOff, { name: names })} />
            )}
            <Flex justify="flex-end" gap={8}>
              <Button onClick={reset}>{PACK_COPY.cancel}</Button>
              <Button
                type="primary"
                loading={applying}
                disabled={chosen.length === 0}
                onClick={() => apply(selected)}
              >
                {chosen.length === 1
                  ? fill(PACK_COPY.impStart, { name: chosen[0]!.display_name })
                  : fill(PACK_COPY.impStart, { name: `${chosen.length} teammates` })}
              </Button>
            </Flex>
          </Flex>
        )}

        {stage === 'import' && receipt && (
          <ImportProgress
            receipt={receipt}
            keys={selected.length ? selected : receipt.results.map((r) => r.key)}
            fileChip={fileChip(PACK_COPY.impProgress)}
            applying={applying}
            onRetry={(keys) => apply(keys)}
            onOpenTeammate={onOpenTeammate}
          />
        )}
      </Flex>
    </div>
  );
};

function ImportProgress({
  receipt,
  keys,
  fileChip,
  applying,
  onRetry,
  onOpenTeammate,
}: {
  receipt: AgorPackImport;
  keys: string[];
  fileChip: React.ReactNode;
  applying: boolean;
  onRetry: (keys: string[]) => void;
  onOpenTeammate?: (branchId: string) => void;
}) {
  const { token } = theme.useToken();
  const rows = receipt.manifest.teammates.filter((t) => keys.includes(t.key));
  const resultOf = (key: string) => receipt.results.find((r) => r.key === key);
  const finished = rows.filter((t) => {
    const result = resultOf(t.key);
    return result && result.filesystem !== 'pending';
  }).length;
  const failed = receipt.status === 'failed';
  return (
    <Flex vertical gap="middle">
      {fileChip}
      <Progress
        percent={rows.length ? Math.round((finished / rows.length) * 100) : 0}
        status={failed ? 'exception' : finished === rows.length ? 'success' : 'active'}
      />
      <Flex
        vertical
        gap={10}
        style={{
          padding: 12,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
        }}
      >
        {rows.map((teammate, index) => {
          const result = resultOf(teammate.key);
          const running = !result && !failed && index === receipt.results.length;
          const state = result
            ? result.filesystem === 'pending'
              ? PACK_COPY.progMoving
              : PACK_COPY.progDone
            : running && receipt.status === 'applying'
              ? PACK_COPY.progMoving
              : PACK_COPY.progWaiting;
          return (
            <Flex key={teammate.key} align="center" gap={8}>
              {result?.filesystem === 'failed' ? (
                <CloseCircleFilled style={{ color: token.colorError }} />
              ) : state === PACK_COPY.progDone ? (
                <CheckCircleFilled style={{ color: token.colorSuccess }} />
              ) : state === PACK_COPY.progMoving ? (
                <LoadingOutlined />
              ) : (
                <ClockCircleOutlined style={{ color: token.colorTextTertiary }} />
              )}
              <Typography.Text style={{ flex: 1 }}>
                {teammate.emoji ?? '🤖'} {teammate.display_name}
              </Typography.Text>
              {result?.filesystem === 'failed' ? (
                <>
                  <Tag color="error">{result.filesystem_error ?? 'files failed'}</Tag>
                  <Button size="small" loading={applying} onClick={() => onRetry([teammate.key])}>
                    {PACK_COPY.progRetry}
                  </Button>
                </>
              ) : (
                <Typography.Text type="secondary">{state}</Typography.Text>
              )}
              {result && result.filesystem !== 'pending' && onOpenTeammate && (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => onOpenTeammate(result.branch_id)}
                >
                  {PACK_COPY.fsOpen}
                </Button>
              )}
            </Flex>
          );
        })}
      </Flex>
      {failed && (
        <Alert
          type="error"
          showIcon
          message={receipt.error ?? 'The import stopped part-way'}
          action={
            <Button size="small" loading={applying} onClick={() => onRetry(keys)}>
              {PACK_COPY.progRetry}
            </Button>
          }
        />
      )}
      {receipt.results.flatMap((result) =>
        result.warnings.map((warning) => (
          <Typography.Text key={`${result.key}:${warning}`} type="secondary">
            {result.display_name}: {warning}
          </Typography.Text>
        ))
      )}
      {!failed && finished < rows.length && (
        <Typography.Text type="secondary">
          <InfoCircleOutlined /> {PACK_COPY.impClose}
        </Typography.Text>
      )}
    </Flex>
  );
}
