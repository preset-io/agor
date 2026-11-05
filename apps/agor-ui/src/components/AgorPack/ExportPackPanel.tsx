import {
  AGOR_PACK_DEFAULT_SESSION_MODE,
  AGOR_PACK_SECTIONS,
  type AgorPackPreflightTeammate,
  type AgorPackSection,
  type AgorPackSessionMode,
  agorPackArchivedNotes,
  agorPackOutsideLinksNote,
  pluralize,
} from '@agor/core/types';
import type { Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { DownloadOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Flex,
  Form,
  Radio,
  Select,
  Skeleton,
  Space,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { type AgorPackExportResult, exportPack, fetchPackPreflight } from '../../utils/agorPack';
import { useThemedMessage } from '../../utils/message';
import { Tag } from '../Tag';

const SECTION_LABELS: Record<AgorPackSection, string> = {
  board: 'Board',
  knowledge: 'Knowledge',
  knowledge_history: '+ version history',
  artifacts: 'Artifacts',
  schedules: 'Schedules',
  claude_memory: 'Claude memory',
  uploads: 'Attachments',
};

const ENVIRONMENT_TAG: Record<string, { color: string; label: string }> = {
  ok: { color: 'success', label: 'ok' },
  needs_webhook: { color: 'warning', label: 'needs webhook' },
  wont_run_in_cloud: { color: 'error', label: "won't run in Cloud" },
};

export interface ExportPackPanelProps {
  teammates: Branch[];
  initialBranchIds: string[];
  /** Called after the file downloaded. */
  onExported?: (result: AgorPackExportResult) => void;
  exportLabel?: string;
}

/** Teammate picker, contents checkboxes, preflight, and the export action. */
export const ExportPackPanel: React.FC<ExportPackPanelProps> = ({
  teammates,
  initialBranchIds,
  onExported,
  exportLabel = 'Export .agorpack',
}) => {
  const { showError, showSuccess } = useThemedMessage();
  const [branchIds, setBranchIds] = useState<string[]>(initialBranchIds);
  const [sections, setSections] = useState<AgorPackSection[]>([...AGOR_PACK_SECTIONS]);
  const [sessions, setSessions] = useState<AgorPackSessionMode>(AGOR_PACK_DEFAULT_SESSION_MODE);
  const [includeOthers, setIncludeOthers] = useState(false);
  const [preflight, setPreflight] = useState<AgorPackPreflightTeammate[] | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (branchIds.length === 0) {
      setPreflight([]);
      return;
    }
    let cancelled = false;
    setPreflight(null);
    setPreflightError(null);
    fetchPackPreflight(branchIds)
      .then((result) => !cancelled && setPreflight(result))
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreflight([]);
        setPreflightError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [branchIds]);

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

  const othersCount = (preflight ?? []).reduce(
    (sum, t) => sum + (sessions === 'all' ? t.sessions.others : t.sessions.recent_others),
    0
  );

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await exportPack({
        branch_ids: branchIds,
        sections,
        sessions,
        include_others_sessions: sessions !== 'none' && includeOthers,
      });
      showSuccess(`Exported ${result.filename}`);
      onExported?.(result);
    } catch (error) {
      showError(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Flex vertical gap="middle">
      <Form layout="vertical" requiredMark={false}>
        <Form.Item label="Teammates" style={{ marginBottom: 12 }}>
          <Select
            mode="multiple"
            value={branchIds}
            onChange={setBranchIds}
            options={options}
            placeholder="Choose teammates"
            aria-label="Teammates to export"
          />
        </Form.Item>
        <Form.Item label="Include" style={{ marginBottom: 12 }}>
          <Checkbox.Group
            value={sections}
            onChange={(value) => {
              const next = value as AgorPackSection[];
              setSections(
                next.includes('knowledge') ? next : next.filter((s) => s !== 'knowledge_history')
              );
            }}
            options={AGOR_PACK_SECTIONS.map((section) => ({
              value: section,
              label: SECTION_LABELS[section],
              disabled: section === 'knowledge_history' && !sections.includes('knowledge'),
            }))}
          />
        </Form.Item>
        <Form.Item label="Session history" style={{ marginBottom: 4 }}>
          <Radio.Group
            value={sessions}
            onChange={(event) => setSessions(event.target.value)}
            options={[
              { value: 'none', label: 'None' },
              { value: 'last_30_days', label: 'Last 30 days' },
              { value: 'all', label: 'All' },
            ]}
          />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Checkbox
            checked={sessions !== 'none' && includeOthers}
            disabled={sessions === 'none'}
            onChange={(event) => setIncludeOthers(event.target.checked)}
          >
            Include other people's sessions{othersCount > 0 ? ` (${othersCount})` : ''}
          </Checkbox>
        </Form.Item>
      </Form>

      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          Before you export
        </Typography.Title>
        {preflightError && <Alert type="error" showIcon message={preflightError} />}
        {preflight === null ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : (
          <Flex vertical gap="small">
            {preflight.map((teammate) => (
              <Alert
                key={teammate.branch_id}
                type={teammate.warnings.length ? 'warning' : 'info'}
                showIcon
                message={
                  <Space wrap size={4}>
                    <Typography.Text strong>{teammate.display_name}</Typography.Text>
                    {teammate.local_home && <Tag>full tree</Tag>}
                    <Typography.Text type="secondary">
                      {pluralize(teammate.knowledge_documents, 'doc')} ·{' '}
                      {pluralize(teammate.artifacts, 'artifact')} ·{' '}
                      {pluralize(teammate.schedules, 'schedule')} · {teammate.sessions.own} of your
                      sessions
                    </Typography.Text>
                  </Space>
                }
                description={
                  <Flex vertical gap={4}>
                    {teammate.warnings.map((warning) => (
                      <span key={warning}>{warning}</span>
                    ))}
                    {[
                      ...agorPackArchivedNotes({
                        sessions: sessions === 'none' ? 0 : teammate.archived.sessions,
                        knowledge_documents: sections.includes('knowledge')
                          ? teammate.archived.knowledge_documents
                          : 0,
                        private_knowledge_documents: sections.includes('knowledge')
                          ? teammate.archived.private_knowledge_documents
                          : 0,
                        artifacts:
                          sections.includes('board') || sections.includes('artifacts')
                            ? teammate.archived.artifacts
                            : 0,
                      }),
                      sections.includes('knowledge')
                        ? agorPackOutsideLinksNote(teammate.knowledge_outside_links)
                        : null,
                    ]
                      .filter((note): note is string => Boolean(note))
                      .map((note) => (
                        <Typography.Text key={note} type="secondary">
                          {note}
                        </Typography.Text>
                      ))}
                    {teammate.requirements.env_vars.length > 0 && (
                      <span>
                        Names only:{' '}
                        {teammate.requirements.env_vars.map((v) => (
                          <Tag key={v.name}>{v.name}</Tag>
                        ))}
                      </span>
                    )}
                    {teammate.environment.variants.length > 0 && (
                      <span>
                        Environment:{' '}
                        {teammate.environment.variants.map((variant) => (
                          <Tag key={variant.name} color={ENVIRONMENT_TAG[variant.status]?.color}>
                            {variant.name}: {ENVIRONMENT_TAG[variant.status]?.label}
                          </Tag>
                        ))}
                      </span>
                    )}
                  </Flex>
                }
              />
            ))}
            <Typography.Text type="secondary">
              Secrets never leave this install: credentials travel by name and you reconnect them
              after import.
            </Typography.Text>
          </Flex>
        )}
      </div>

      <Flex justify="flex-end">
        <Button
          type="primary"
          icon={<DownloadOutlined />}
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
