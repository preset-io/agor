import type { AgorPackSwitchOverState } from '@agor/core/types';
import type { Branch, User } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { CloudUploadOutlined, ExportOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, List, Space, Steps, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  type AgorPackExportResult,
  fetchPackPreflight,
  switchOverTeammate,
} from '../../utils/agorPack';
import { useThemedMessage } from '../../utils/message';
import { pluralize } from '../../utils/pluralize';
import { ExportPackPanel } from '../AgorPack/ExportPackPanel';
import { Tag } from '../Tag';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';

/** Where people create and open their Agor Cloud workspace. */
export const AGOR_CLOUD_URL = 'https://agor.cloud';

export interface MoveToCloudSectionProps {
  currentUser?: User | null;
  branchById: Map<string, Branch>;
}

/**
 * Self-hosted → Agor Cloud: export teammates to a .agorpack, import it in the
 * Cloud workspace, then switch over here so both copies don't run at once.
 */
export const MoveToCloudSection: React.FC<MoveToCloudSectionProps> = ({
  currentUser,
  branchById,
}) => {
  const { showError, showSuccess, showWarning } = useThemedMessage();
  const teammates = useMemo(
    () =>
      [...branchById.values()]
        .filter((branch) => !branch.archived && isTeammate(branch))
        .sort((a, b) =>
          (getTeammateConfig(a)?.displayName ?? a.name).localeCompare(
            getTeammateConfig(b)?.displayName ?? b.name
          )
        ),
    [branchById]
  );
  const mine = useMemo(
    () =>
      teammates
        .filter((branch) => branch.created_by === currentUser?.user_id)
        .map((branch) => branch.branch_id),
    [teammates, currentUser?.user_id]
  );
  const [step, setStep] = useState(0);
  const [exported, setExported] = useState<AgorPackExportResult | null>(null);
  const [switchState, setSwitchState] = useState<Record<string, AgorPackSwitchOverState | null>>(
    {}
  );
  const [busy, setBusy] = useState<string | null>(null);
  const movedIds = useMemo(
    () => exported?.manifest.teammates.map((t) => t.source_branch_id) ?? mine,
    [exported, mine]
  );

  useEffect(() => {
    if (step !== 2 || movedIds.length === 0) return;
    let cancelled = false;
    fetchPackPreflight(movedIds)
      .then((rows) => {
        if (cancelled) return;
        setSwitchState(Object.fromEntries(rows.map((row) => [row.branch_id, row.switch_over])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [step, movedIds]);

  const toggleSwitch = async (branchId: string, undo: boolean) => {
    setBusy(branchId);
    try {
      const result = await switchOverTeammate(branchId, undo);
      setSwitchState((prev) => ({ ...prev, [branchId]: result.switch_over }));
      for (const warning of result.warnings) showWarning(warning);
      showSuccess(undo ? 'Resumed here' : 'Paused here');
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <ResponsiveSettingsHeader
        title="Move to Agor Cloud"
        description="Bring your teammates to Agor Cloud with their board, memory, artifacts, schedules, and history. Credentials stay here; you reconnect them in Cloud."
      />
      <Flex vertical gap="large">
        <Steps
          size="small"
          current={step}
          onChange={setStep}
          items={[{ title: 'Export' }, { title: 'Import in Cloud' }, { title: 'Switch over' }]}
        />

        {step === 0 &&
          (teammates.length === 0 ? (
            <Alert type="info" showIcon message="There are no teammates to move yet." />
          ) : (
            <ExportPackPanel
              teammates={teammates}
              initialBranchIds={mine.length ? mine : teammates.map((t) => t.branch_id)}
              exportLabel="Download .agorpack"
              onExported={(result) => {
                setExported(result);
                setStep(1);
              }}
            />
          ))}

        {step === 1 && (
          <Flex vertical gap="middle">
            {exported && (
              <Alert
                type="success"
                showIcon
                message={`Downloaded ${exported.filename}`}
                description={`${pluralize(exported.manifest.teammates.length, 'teammate')}, ${(exported.size / 1024 / 1024).toFixed(1)} MB.`}
              />
            )}
            <Typography.Paragraph>
              In your Agor Cloud workspace, open{' '}
              <Typography.Text strong>Settings → Teammates</Typography.Text> and choose{' '}
              <Typography.Text strong>Import .agorpack</Typography.Text>. You'll review what's
              inside before anything is created, then reconnect credentials and turn schedules on.
            </Typography.Paragraph>
            <Space>
              <Button
                type="primary"
                icon={<ExportOutlined />}
                href={AGOR_CLOUD_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Agor Cloud
              </Button>
              <Button onClick={() => setStep(2)}>I've imported it</Button>
            </Space>
          </Flex>
        )}

        {step === 2 && (
          <Flex vertical gap="middle">
            <Typography.Paragraph type="secondary">
              Pause each teammate here once its Cloud copy is running, so schedules don't fire twice
              and Slack doesn't get two replies. Undo resumes exactly what was paused.
            </Typography.Paragraph>
            <List
              bordered
              dataSource={teammates.filter((t) => movedIds.includes(t.branch_id))}
              renderItem={(branch) => {
                const state = switchState[branch.branch_id];
                const config = getTeammateConfig(branch);
                return (
                  <List.Item
                    actions={[
                      state ? (
                        <Button
                          key="undo"
                          loading={busy === branch.branch_id}
                          onClick={() => toggleSwitch(branch.branch_id, true)}
                        >
                          Undo
                        </Button>
                      ) : (
                        <Button
                          key="switch"
                          type="primary"
                          icon={<CloudUploadOutlined />}
                          loading={busy === branch.branch_id}
                          onClick={() => toggleSwitch(branch.branch_id, false)}
                        >
                          Switch over
                        </Button>
                      ),
                    ]}
                  >
                    <Space wrap>
                      <Typography.Text>
                        {config?.emoji ?? '🤖'} {config?.displayName ?? branch.name}
                      </Typography.Text>
                      {state ? (
                        <Tag color="success">
                          paused here · {pluralize(state.disabled_schedule_ids.length, 'schedule')},{' '}
                          {pluralize(state.disabled_channel_ids.length, 'channel')}
                        </Tag>
                      ) : (
                        <Tag>running here</Tag>
                      )}
                    </Space>
                  </List.Item>
                );
              }}
            />
          </Flex>
        )}
      </Flex>
    </div>
  );
};
