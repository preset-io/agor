import {
  AGOR_CLOUD,
  type AgorCloudLinkCompleteRequest,
  type AgorCloudLinkStatus,
  type AgorCloudTransfer,
  type AgorPackSwitchOverState,
  hasMinimumRole,
  pluralize,
  ROLES,
} from '@agor/core/types';
import type { Branch, User } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { CloudOutlined, CloudUploadOutlined, ExportOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Flex,
  List,
  Progress,
  Result,
  Space,
  Spin,
  Steps,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AgorPackExportResult,
  applyCloudTransfer,
  completeCloudLink,
  disconnectCloudLink,
  fetchPackPreflight,
  getCloudLink,
  getCloudTransfer,
  startCloudLink,
  startCloudTransfer,
  switchOverTeammate,
} from '../../utils/agorPack';
import { useThemedMessage } from '../../utils/message';
import { ExportPackPanel } from '../AgorPack/ExportPackPanel';
import { locked, PackReviewTable } from '../AgorPack/PackReviewTable';
import { Tag } from '../Tag';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';

type CloudReturn = AgorCloudLinkCompleteRequest;

/**
 * The Cloud console comes back with a one-time launch code in the URL
 * fragment. Take it off the URL right away (before any client-side
 * navigation can drop it, and so it never sits in history), and keep it until
 * the user confirms or cancels the connection.
 */
function readCloudReturn(): CloudReturn | null {
  if (typeof window === 'undefined' || !window.location.hash.includes('launch_code=')) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`
  );
  const state = params.get('state');
  const launchCode = params.get('launch_code');
  const workspaceUrl = params.get('workspace_url');
  if (!state || !launchCode || !workspaceUrl) return null;
  return {
    state,
    launch_code: launchCode,
    workspace_url: workspaceUrl,
    ...(params.get('workspace_display_name')
      ? { workspace_display_name: params.get('workspace_display_name') as string }
      : {}),
    ...(params.get('team_slug') ? { team_slug: params.get('team_slug') as string } : {}),
  };
}
let pendingCloudReturn = readCloudReturn();
function peekCloudReturn(): CloudReturn | null {
  pendingCloudReturn ??= readCloudReturn();
  return pendingCloudReturn;
}
function clearCloudReturn(): void {
  pendingCloudReturn = null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export interface MoveToCloudSectionProps {
  currentUser?: User | null;
  branchById: Map<string, Branch>;
}

/**
 * Self-hosted → Agor Cloud: sign in to a Cloud workspace, send teammates
 * there, import and reconnect them in Cloud, then switch over here so both
 * copies don't run at once. Downloading a .agorpack stays as a fallback.
 * Members move their own teammates; admins can move anyone's.
 */
export const MoveToCloudSection: React.FC<MoveToCloudSectionProps> = ({
  currentUser,
  branchById,
}) => {
  const { showError, showSuccess, showWarning } = useThemedMessage();
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const teammates = useMemo(
    () =>
      [...branchById.values()]
        .filter(
          (branch) =>
            !branch.archived &&
            isTeammate(branch) &&
            (isAdmin || branch.created_by === currentUser?.user_id)
        )
        .sort((a, b) =>
          (getTeammateConfig(a)?.displayName ?? a.name).localeCompare(
            getTeammateConfig(b)?.displayName ?? b.name
          )
        ),
    [branchById, isAdmin, currentUser?.user_id]
  );
  const mine = useMemo(
    () =>
      teammates
        .filter((branch) => branch.created_by === currentUser?.user_id)
        .map((branch) => branch.branch_id),
    [teammates, currentUser?.user_id]
  );

  // "cloud": sign in and send; "file": download a .agorpack and upload it yourself.
  const [mode, setMode] = useState<'cloud' | 'file'>('cloud');
  const [step, setStep] = useState(0);
  const [cloud, setCloud] = useState<AgorCloudLinkStatus | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [returned, setReturned] = useState<CloudReturn | null>(() => peekCloudReturn());
  const [transfer, setTransfer] = useState<AgorCloudTransfer | null>(null);
  const [reviewKeys, setReviewKeys] = useState<string[]>([]);
  const [exported, setExported] = useState<AgorPackExportResult | null>(null);
  const [switchState, setSwitchState] = useState<Record<string, AgorPackSwitchOverState | null>>(
    {}
  );
  const [busy, setBusy] = useState<string | null>(null);

  const consoleUrl = cloud?.console_url ?? AGOR_CLOUD.defaultConsoleUrl;
  const link = cloud?.link ?? null;
  const switchStep = mode === 'cloud' ? 3 : 2;
  const movedIds = useMemo(
    () =>
      (transfer?.import?.manifest ?? exported?.manifest)?.teammates.map(
        (t) => t.source_branch_id
      ) ?? mine,
    [transfer, exported, mine]
  );

  useEffect(() => {
    let cancelled = false;
    getCloudLink()
      .then((status) => !cancelled && setCloud(status))
      .catch((error: unknown) => {
        if (cancelled) return;
        setCloud({ console_url: AGOR_CLOUD.defaultConsoleUrl, link: null });
        setCloudError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A staged pack opens on its review with every importable teammate selected.
  const showTransfer = useCallback((next: AgorCloudTransfer) => {
    setTransfer(next);
    const receipt = next.import;
    if (next.status === 'staged' && receipt) {
      setReviewKeys(receipt.dry_run.filter((d) => !locked(receipt, d.key)).map((d) => d.key));
    }
  }, []);

  // Follow the upload, then the apply in Cloud.
  const transferId = transfer?.transfer_id;
  const following = transfer?.status === 'uploading' || transfer?.status === 'applying';
  useEffect(() => {
    if (!transferId || !following) return;
    const timer = setInterval(() => {
      getCloudTransfer(transferId)
        .then(showTransfer)
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [transferId, following, showTransfer]);

  useEffect(() => {
    if (step !== switchStep || movedIds.length === 0) return;
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
  }, [step, switchStep, movedIds]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try {
      await work();
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const signIn = () =>
    run('sign-in', async () => {
      const { authorize_url } = await startCloudLink(
        `${window.location.origin}${window.location.pathname}`
      );
      window.location.assign(authorize_url);
    });

  const connect = (fields: CloudReturn) =>
    run('connect', async () => {
      clearCloudReturn();
      setReturned(null);
      try {
        setCloud(await completeCloudLink(fields));
        setCloudError(null);
        setStep(1);
      } catch (error) {
        setCloudError(error instanceof Error ? error.message : String(error));
      }
    });

  const disconnect = () =>
    run('disconnect', async () => {
      setCloud(await disconnectCloudLink());
      setTransfer(null);
      setStep(0);
    });

  const send = async (result: AgorPackExportResult) => {
    try {
      showTransfer(await startCloudTransfer(result.export_id, result.ref));
      setStep(2);
    } catch (error) {
      showError(`Send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const apply = () =>
    run('apply', async () => {
      if (!transfer) return;
      setTransfer(await applyCloudTransfer(transfer.transfer_id, reviewKeys));
    });

  const finish = () =>
    run('done', async () => {
      if (link) setCloud(await disconnectCloudLink());
      setTransfer(null);
      setExported(null);
      setStep(0);
      showSuccess('All done. This install no longer keeps your Agor Cloud sign-in.');
    });

  const toggleSwitch = (branchId: string, undo: boolean) =>
    run(branchId, async () => {
      const result = await switchOverTeammate(branchId, undo);
      setSwitchState((prev) => ({ ...prev, [branchId]: result.switch_over }));
      for (const warning of result.warnings) showWarning(warning);
      showSuccess(undo ? 'Resumed here' : 'Paused here');
    });

  const noTeammates = teammates.length === 0 && (
    <Alert type="info" showIcon message="You have no AI teammates to move yet." />
  );

  const fileFallback = (
    <Button
      type="link"
      style={{ padding: 0 }}
      onClick={() => {
        setMode('file');
        setStep(0);
      }}
    >
      Download a .agorpack file instead
    </Button>
  );

  const renderSignIn = () => {
    if (returned) {
      const host = hostOf(returned.workspace_url);
      return (
        <Card>
          <Flex vertical gap="middle">
            <Typography.Title level={5} style={{ margin: 0 }}>
              Connect to {returned.workspace_display_name ?? host}?
            </Typography.Title>
            <Typography.Paragraph style={{ margin: 0 }}>
              Agor will sign in to <Typography.Text code>{host}</Typography.Text> as you, so it can
              send your teammates there. Only connect if you just started this sign-in.
            </Typography.Paragraph>
            <Space>
              <Button
                type="primary"
                icon={<CloudOutlined />}
                loading={busy === 'connect'}
                onClick={() => connect(returned)}
              >
                Connect to {host}
              </Button>
              <Button
                onClick={() => {
                  clearCloudReturn();
                  setReturned(null);
                }}
              >
                Cancel
              </Button>
            </Space>
          </Flex>
        </Card>
      );
    }
    if (!cloud) return <Spin />;
    if (link) {
      return (
        <Card>
          <Flex vertical gap="middle">
            <Descriptions
              size="small"
              column={1}
              items={[
                {
                  key: 'workspace',
                  label: 'Workspace',
                  children: link.workspace_display_name ?? hostOf(link.workspace_url),
                },
                { key: 'url', label: 'Address', children: hostOf(link.workspace_url) },
                ...(link.team_slug
                  ? [{ key: 'team', label: 'Team', children: link.team_slug }]
                  : []),
                ...(link.cloud_email
                  ? [{ key: 'email', label: 'Signed in as', children: link.cloud_email }]
                  : []),
              ]}
            />
            <Space>
              <Button type="primary" onClick={() => setStep(1)}>
                Continue
              </Button>
              <Button loading={busy === 'disconnect'} onClick={disconnect}>
                Disconnect
              </Button>
            </Space>
          </Flex>
        </Card>
      );
    }
    return (
      <Flex vertical gap="middle" align="flex-start">
        {cloudError && (
          <Alert type="error" showIcon message={cloudError} style={{ alignSelf: 'stretch' }} />
        )}
        <Typography.Paragraph style={{ margin: 0 }}>
          Sign in to Agor Cloud and pick the workspace your teammates should move to. You come
          straight back here to send them.
        </Typography.Paragraph>
        <Button
          type="primary"
          icon={<CloudOutlined />}
          loading={busy === 'sign-in'}
          onClick={signIn}
        >
          Sign in to Agor Cloud
        </Button>
        {fileFallback}
      </Flex>
    );
  };

  const renderTransfer = () => {
    if (!transfer) return null;
    const receipt = transfer.import;
    const host = hostOf(transfer.workspace_url);
    if (transfer.status === 'uploading') {
      const percent = transfer.bytes_total
        ? Math.floor((transfer.bytes_sent / transfer.bytes_total) * 100)
        : 0;
      return (
        <Flex vertical gap="small">
          <Typography.Text>Sending to {host}…</Typography.Text>
          <Progress percent={percent} status="active" />
        </Flex>
      );
    }
    if (transfer.status === 'failed' && !receipt) {
      return (
        <Alert
          type="error"
          showIcon
          message="Sending stopped"
          description={transfer.error}
          action={
            <Button size="small" onClick={() => setStep(1)}>
              Try again
            </Button>
          }
        />
      );
    }
    if (!receipt) return null;
    if (transfer.status === 'staged') {
      return (
        <Flex vertical gap="middle">
          <Typography.Text type="secondary">
            Here is what {host} will create. You will own everything imported; schedules arrive
            paused and each teammate gets its own board.
          </Typography.Text>
          <PackReviewTable receipt={receipt} selected={reviewKeys} onSelect={setReviewKeys} />
          <Flex justify="flex-end">
            <Button
              type="primary"
              icon={<CloudUploadOutlined />}
              loading={busy === 'apply'}
              disabled={reviewKeys.length === 0}
              onClick={apply}
            >
              Import {pluralize(reviewKeys.length, 'teammate')} into Agor Cloud
            </Button>
          </Flex>
        </Flex>
      );
    }
    if (transfer.status === 'applying') {
      return (
        <Alert
          type="info"
          showIcon
          icon={<Spin size="small" />}
          message={`Importing in ${host}… ${receipt.results.length} of ${pluralize(receipt.manifest.teammates.length, 'teammate')} done`}
        />
      );
    }
    if (transfer.status === 'failed') {
      return (
        <Alert
          type="error"
          showIcon
          message="The import stopped part-way"
          description={`${transfer.error ?? 'Unknown error'}. Resuming continues where it stopped; nothing is imported twice.`}
          action={
            <Button size="small" loading={busy === 'apply'} onClick={apply}>
              Resume
            </Button>
          }
        />
      );
    }
    return (
      <Result
        status="success"
        title={`${pluralize(receipt.results.length, 'teammate')} imported into ${host}`}
        subTitle="Open the reconnect checklist in Agor Cloud to add credentials and turn schedules back on. Files keep restoring in the background."
        extra={[
          <Button
            key="open"
            type="primary"
            icon={<ExportOutlined />}
            href={transfer.open_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open reconnect checklist in Agor Cloud
          </Button>,
          <Button key="next" onClick={() => setStep(3)}>
            Next: switch over here
          </Button>,
        ]}
      />
    );
  };

  const renderSwitchOver = () => (
    <Flex vertical gap="middle">
      <Typography.Paragraph type="secondary">
        Pause each teammate here once its Cloud copy is running, so schedules don't fire twice and
        Slack doesn't get two replies. Undo resumes exactly what was paused.
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
      {mode === 'cloud' && (
        <Flex justify="flex-end">
          <Button type="primary" loading={busy === 'done'} onClick={finish}>
            Done
          </Button>
        </Flex>
      )}
    </Flex>
  );

  return (
    <div>
      <ResponsiveSettingsHeader
        title="Move to Agor Cloud"
        description="Bring your AI teammates to Agor Cloud with their board, memory, artifacts, schedules, and history. Credentials stay here; you reconnect them in Cloud."
      />
      <Flex vertical gap="large">
        {mode === 'cloud' ? (
          <>
            <Steps
              size="small"
              current={step}
              onChange={(next) => (next === 0 || link) && setStep(next)}
              items={[
                { title: 'Sign in' },
                { title: 'Send', disabled: !link },
                { title: 'Import in Cloud', disabled: !transfer },
                { title: 'Switch over', disabled: !link && !transfer },
              ]}
            />
            {step === 0 && renderSignIn()}
            {step === 1 &&
              (noTeammates || (
                <Flex vertical gap="middle">
                  {link && (
                    <Typography.Text type="secondary">
                      Sending to{' '}
                      <Typography.Text strong>
                        {link.workspace_display_name ?? hostOf(link.workspace_url)}
                      </Typography.Text>{' '}
                      ({hostOf(link.workspace_url)})
                    </Typography.Text>
                  )}
                  <ExportPackPanel
                    teammates={teammates}
                    initialBranchIds={mine.length ? mine : teammates.map((t) => t.branch_id)}
                    exportLabel="Send to Agor Cloud"
                    exportIcon={<CloudUploadOutlined />}
                    download={false}
                    onExported={send}
                  />
                </Flex>
              ))}
            {step === 2 && renderTransfer()}
            {step === 3 && renderSwitchOver()}
          </>
        ) : (
          <>
            <Steps
              size="small"
              current={step}
              onChange={setStep}
              items={[{ title: 'Export' }, { title: 'Import in Cloud' }, { title: 'Switch over' }]}
            />
            <Button
              type="link"
              style={{ padding: 0, alignSelf: 'flex-start' }}
              onClick={() => {
                setMode('cloud');
                setStep(0);
              }}
            >
              Sign in to Agor Cloud and send instead
            </Button>
            {step === 0 &&
              (noTeammates || (
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
                  inside before anything is created, then reconnect credentials and turn schedules
                  on.
                </Typography.Paragraph>
                <Space>
                  <Button
                    type="primary"
                    icon={<ExportOutlined />}
                    href={consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Agor Cloud
                  </Button>
                  <Button onClick={() => setStep(2)}>I've imported it</Button>
                </Space>
              </Flex>
            )}
            {step === 2 && renderSwitchOver()}
          </>
        )}
      </Flex>
    </div>
  );
};
