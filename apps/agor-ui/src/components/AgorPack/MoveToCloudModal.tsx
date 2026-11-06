import {
  AGOR_CLOUD,
  AGOR_PACK_DEFAULT_SESSION_MODE,
  type AgorCloudLinkCompleteRequest,
  type AgorCloudLinkStatus,
  type AgorCloudMove,
  type AgorCloudMoveItem,
  type AgorPackExportRequest,
  type AgorPackSessionMode,
  type AgorPackSwitchOverState,
  agorCloudReturnToProblem,
  agorCloudWorkspacePageUrl,
} from '@agor/core/types';
import type { Branch, User } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import {
  ArrowRightOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloudUploadOutlined,
  DownloadOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  LoginOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Flex,
  Progress,
  Radio,
  Skeleton,
  Spin,
  Steps,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectBranchById } from '../../store/selectors';
import {
  completeCloudLink,
  disconnectCloudLink,
  exportPack,
  getCloudLink,
  getCloudMove,
  getLatestCloudMove,
  retryCloudMove,
  startCloudLink,
  startCloudMove,
  switchOverTeammate,
} from '../../utils/agorPack';
import { useThemedMessage } from '../../utils/message';
import { uiRouteHref } from '../../utils/uiRoutes';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';
import { Tag } from '../Tag';
import { CheckReport } from './CheckReport';
import { usePackPreflight } from './ExportPackPanel';
import { canExportTeammate, checkFromPreflight, exportEstimate } from './packCheck';
import { countLabel, fill, listNames, megabytes, PACK_COPY } from './packCopy';
import { SessionHistoryPicker } from './SessionHistoryPicker';

export type CloudReturn = AgorCloudLinkCompleteRequest;

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
export function peekCloudReturn(): CloudReturn | null {
  pendingCloudReturn ??= readCloudReturn();
  return pendingCloudReturn;
}
function clearCloudReturn(): void {
  pendingCloudReturn = null;
}

/** Where the console sends the browser back to: Settings → Agor Cloud. */
export function cloudReturnTo(): string {
  return `${window.location.origin}${uiRouteHref('/settings/move-to-cloud/')}`;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const nameOf = (branch: Branch) => getTeammateConfig(branch)?.displayName ?? branch.name;
const emojiOf = (branch: Branch) => getTeammateConfig(branch)?.emoji ?? '🤖';

/** Teammates this user may move: members their own, admins anyone's. */
export function useMovableTeammates(user: User | null | undefined): Branch[] {
  const branchById = useAgorStore(selectBranchById);
  return useMemo(
    () =>
      [...branchById.values()]
        .filter(
          (branch) => !branch.archived && isTeammate(branch) && canExportTeammate(user, branch)
        )
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
    [branchById, user]
  );
}

const STEP_TITLES = PACK_COPY.steps.split(' · ');

/** Overall progress of a move: each teammate counts the same. */
export function movePercent(move: AgorCloudMove): number {
  const part = (item: AgorCloudMoveItem) => {
    switch (item.status) {
      case 'done':
      case 'failed':
        return 1;
      case 'exporting':
        return 0.1;
      case 'sending':
        return 0.1 + 0.8 * (item.bytes_total ? item.bytes_sent / item.bytes_total : 0);
      case 'importing':
        return 0.9;
      default:
        return 0;
    }
  };
  const total = move.items.reduce((sum, item) => sum + part(item), 0);
  return move.items.length ? Math.floor((total / move.items.length) * 100) : 0;
}

/** A bordered radio row, like the design's option cards. */
const OptionCard: React.FC<{
  checked: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
}> = ({ checked, onSelect, icon, title, description }) => {
  const { token } = theme.useToken();
  return (
    <Flex
      align="flex-start"
      gap={10}
      role="radio"
      aria-checked={checked}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onSelect()}
      style={{
        padding: '10px 12px',
        cursor: 'pointer',
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${checked ? token.colorPrimary : token.colorBorderSecondary}`,
        background: checked ? token.colorPrimaryBg : undefined,
      }}
    >
      <Radio checked={checked} style={{ marginTop: 2, marginInlineEnd: 0 }} />
      {icon}
      <Flex vertical style={{ minWidth: 0 }}>
        <Typography.Text strong>{title}</Typography.Text>
        {description && <Typography.Text type="secondary">{description}</Typography.Text>}
      </Flex>
    </Flex>
  );
};

/** Switch over (pause schedules and channels here) / Switch back, per teammate. */
export const SwitchOverControl: React.FC<{
  branchId: string;
  state: AgorPackSwitchOverState | null | undefined;
  onChange: (state: AgorPackSwitchOverState | null) => void;
}> = ({ branchId, state, onChange }) => {
  const { showError, showWarning } = useThemedMessage();
  const [busy, setBusy] = useState(false);
  const toggle = async (undo: boolean) => {
    setBusy(true);
    try {
      const result = await switchOverTeammate(branchId, undo);
      for (const warning of result.warnings) showWarning(warning);
      onChange(result.switch_over);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return state ? (
    <Flex align="center" gap={8}>
      <Tag color="success">Switched over</Tag>
      <Button size="small" loading={busy} onClick={() => toggle(true)}>
        Switch back
      </Button>
    </Flex>
  ) : (
    <Button size="small" loading={busy} onClick={() => toggle(false)}>
      Switch over
    </Button>
  );
};

export interface MoveToCloudModalProps {
  open: boolean;
  onClose: () => void;
  currentUser: User | null | undefined;
  /** From a teammate menu: just that teammate. From Settings: all of them. */
  initialBranchIds?: string[];
  /** Called when a move starts or changes, so the Settings card can follow it. */
  onMoveChange?: (move: AgorCloudMove) => void;
}

/** Move to Agor Cloud: Sign in · Choose · Check · Move, then Done. */
export const MoveToCloudModal: React.FC<MoveToCloudModalProps> = ({
  open,
  onClose,
  currentUser,
  initialBranchIds,
  onMoveChange,
}) => {
  const { token } = theme.useToken();
  const { showError, showSuccess } = useThemedMessage();
  const teammates = useMovableTeammates(currentUser);
  const boardById = useAgorStore(selectBoardById);
  const boardOf = (branchId: string) => {
    const boardId = teammates.find((t) => t.branch_id === branchId)?.board_id;
    return boardId ? boardById.get(boardId)?.name : undefined;
  };
  const allIds = useMemo<string[]>(() => teammates.map((t) => t.branch_id), [teammates]);

  const [step, setStep] = useState(0);
  const [cloud, setCloud] = useState<AgorCloudLinkStatus | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [returned, setReturned] = useState<CloudReturn | null>(() => peekCloudReturn());
  const [waiting, setWaiting] = useState(false);
  const [workspaceChoice, setWorkspaceChoice] = useState<'linked' | 'new'>('linked');
  /** Skip sign-in and download an .agor file instead. */
  const [fileOnly, setFileOnly] = useState(false);
  const [who, setWho] = useState<'all' | 'pick'>(initialBranchIds ? 'pick' : 'all');
  const [picked, setPicked] = useState<string[]>(initialBranchIds ?? allIds);
  const [sessions, setSessions] = useState<AgorPackSessionMode>(AGOR_PACK_DEFAULT_SESSION_MODE);
  const [leaveOut, setLeaveOut] = useState(true);
  const [move, setMove] = useState<AgorCloudMove | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const link = cloud?.link ?? null;
  const chosen = who === 'all' ? allIds : picked.filter((id) => allIds.includes(id));
  // One preflight for every movable teammate, from Choose on; the steps read the chosen ones.
  const { preflight: allPreflight, error: preflightError } = usePackPreflight(
    step >= 1 ? allIds : []
  );
  const preflight = useMemo(
    () => allPreflight?.filter((t) => chosen.includes(t.branch_id)) ?? null,
    [allPreflight, chosen]
  );
  const check = preflight ? checkFromPreflight(preflight, sessions, false, leaveOut) : null;
  const estimate = preflight ? exportEstimate(preflight, sessions, false) : null;
  const firstName = teammates.find((t) => t.branch_id === chosen[0]);

  const returnTo = cloudReturnTo();
  const returnToProblem = agorCloudReturnToProblem(returnTo);
  const overHttp = window.location.protocol === 'http:';

  const showMove = useCallback(
    (next: AgorCloudMove) => {
      setMove(next);
      onMoveChange?.(next);
    },
    [onMoveChange]
  );

  // On open (also after a reload): the link, and the move the daemon has for
  // it. A running move always shows; a finished one shows while it is for the
  // current sign-in and covers the teammates this was opened for.
  const initialKey = initialBranchIds?.join(',');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const status = getCloudLink().catch((error: unknown) => {
      setCloudError(error instanceof Error ? error.message : String(error));
      return { console_url: AGOR_CLOUD.defaultConsoleUrl, link: null } as AgorCloudLinkStatus;
    });
    const latest = getLatestCloudMove().catch(() => null);
    void Promise.all([status, latest]).then(([linkStatus, last]) => {
      if (cancelled) return;
      setCloud(linkStatus);
      if (!last) return;
      const wanted = initialKey ? initialKey.split(',') : [];
      const restore =
        last.status === 'moving' ||
        (last.workspace_url === linkStatus.link?.workspace_url &&
          wanted.every((id) => last.items.some((item) => item.branch_id === id)));
      if (!restore) return;
      showMove(last);
      setStep(3);
    });
    return () => {
      cancelled = true;
    };
  }, [open, showMove, initialKey]);

  // Waiting for the sign-in in the other tab: it lands on the daemon.
  useEffect(() => {
    if (!open || !waiting) return;
    const timer = setInterval(() => {
      getCloudLink()
        .then((status) => {
          if (!status.link) return;
          setCloud(status);
          setWaiting(false);
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [open, waiting]);

  // Follow the move while it runs. A 404 means the daemon restarted and lost
  // it: stop following and say so.
  const [lost, setLost] = useState(false);
  const moveId = move?.move_id;
  const moving = move?.status === 'moving';
  useEffect(() => {
    if (!open || !moveId || !moving || lost) return;
    const timer = setInterval(() => {
      getCloudMove(moveId)
        .then((next) => (next ? showMove(next) : setLost(true)))
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [open, moveId, moving, lost, showMove]);

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

  /**
   * Open the console in a new tab (same tab when pop-ups are blocked). The tab
   * opens inside the click so pop-up blockers allow it; `before` runs first.
   */
  const openSignIn = (before?: () => Promise<void>) => {
    const tab = window.open('', '_blank');
    void run('sign-in', async () => {
      try {
        await before?.();
        const { authorize_url } = await startCloudLink(returnTo);
        if (tab) {
          tab.opener = null;
          tab.location.href = authorize_url;
          setWaiting(true);
        } else {
          window.location.assign(authorize_url);
        }
      } catch (error) {
        tab?.close();
        throw error;
      }
    });
  };

  const connect = (fields: CloudReturn) =>
    run('connect', async () => {
      clearCloudReturn();
      setReturned(null);
      try {
        setCloud(await completeCloudLink(fields));
        setCloudError(null);
      } catch (error) {
        setCloudError(error instanceof Error ? error.message : String(error));
      }
    });

  const useAnotherAccount = () =>
    openSignIn(async () => {
      setCloud(await disconnectCloudLink());
    });

  const request = (): AgorPackExportRequest => ({
    branch_ids: chosen,
    sessions,
    exclude_session_ids: leaveOut ? (check?.flagged ?? []).map((s) => s.session_id) : [],
  });

  const startMove = () =>
    run('move', async () => {
      showMove(await startCloudMove(request()));
      setStep(3);
    });

  const download = () =>
    run('download', async () => {
      const result = await exportPack(request());
      showSuccess(fill(PACK_COPY.expToast, { file: result.filename }));
      onClose();
    });

  const retry = (branchId: string) =>
    run(`retry:${branchId}`, async () => {
      if (move) showMove(await retryCloudMove(move.move_id, branchId));
    });

  const moveLabel =
    chosen.length === 1 && firstName
      ? fill(PACK_COPY.startBtnOne, { name: nameOf(firstName) })
      : fill(PACK_COPY.startBtn, { n: chosen.length });

  const downloadLink = (
    <Button
      type="link"
      size="small"
      icon={<DownloadOutlined />}
      style={{ padding: 0 }}
      onClick={() => {
        if (step === 2) {
          download();
          return;
        }
        setFileOnly(true);
        setStep(1);
      }}
    >
      Download an .agor file instead
    </Button>
  );

  const stepTitle = (title: string) => (
    <Typography.Title level={5} style={{ margin: '4px 0 0' }}>
      {title}
    </Typography.Title>
  );

  // ---------------------------------------------------------------- Sign in
  const renderSignIn = () => {
    let body: React.ReactNode;
    let footer: React.ReactNode;
    const cancel = <Button onClick={onClose}>{PACK_COPY.cancel}</Button>;
    if (returned) {
      const host = hostOf(returned.workspace_url);
      body = (
        <Flex vertical gap="middle" align="flex-start">
          <Typography.Paragraph style={{ margin: 0 }}>
            Connect to{' '}
            <Typography.Text strong>{returned.workspace_display_name ?? host}</Typography.Text> (
            <Typography.Text code>{host}</Typography.Text>)? Agor will sign in there as you to move
            your teammates. Only connect if you just started this sign-in.
          </Typography.Paragraph>
        </Flex>
      );
      footer = (
        <>
          <Button
            onClick={() => {
              clearCloudReturn();
              setReturned(null);
            }}
          >
            {PACK_COPY.cancel}
          </Button>
          <Button type="primary" loading={busy === 'connect'} onClick={() => connect(returned)}>
            Connect to {host}
          </Button>
        </>
      );
    } else if (!cloud) {
      body = <Spin />;
      footer = cancel;
    } else if (link) {
      const host = hostOf(link.workspace_url);
      const name = link.workspace_display_name ?? host;
      body = (
        <Flex vertical gap={12}>
          <Flex align="center" gap={8} wrap>
            <CheckCircleFilled style={{ color: token.colorSuccess }} />
            <Typography.Text>
              {link.cloud_email
                ? fill(PACK_COPY.signedAs, { email: link.cloud_email })
                : 'Signed in'}
            </Typography.Text>
            <Typography.Link onClick={useAnotherAccount}>{PACK_COPY.signSwitch}</Typography.Link>
          </Flex>
          <Typography.Text strong>{PACK_COPY.pickWs}</Typography.Text>
          <Flex vertical gap={8} role="radiogroup" aria-label={PACK_COPY.pickWs}>
            <OptionCard
              checked={workspaceChoice === 'linked'}
              onSelect={() => setWorkspaceChoice('linked')}
              icon={
                <Avatar shape="square" size={28} style={{ background: token.colorPrimary }}>
                  {name.charAt(0).toUpperCase()}
                </Avatar>
              }
              title={name}
              description={host}
            />
            <OptionCard
              checked={workspaceChoice === 'new'}
              onSelect={() => setWorkspaceChoice('new')}
              icon={<Avatar shape="square" size={28} icon={<PlusOutlined />} />}
              title={PACK_COPY.wsCreate}
              description={PACK_COPY.wsCreateD}
            />
          </Flex>
        </Flex>
      );
      footer = (
        <>
          {cancel}
          <Button
            type="primary"
            loading={busy === 'sign-in'}
            onClick={() => {
              // A new workspace is made on the Agor Cloud sign-in page.
              if (workspaceChoice === 'new') openSignIn();
              else setStep(1);
            }}
          >
            {PACK_COPY.continue}
          </Button>
        </>
      );
    } else if (waiting) {
      body = (
        <Flex
          align="center"
          gap={12}
          style={{
            padding: '14px 16px',
            borderRadius: token.borderRadiusLG,
            background: token.colorFillQuaternary,
          }}
        >
          <LoadingOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
          <Flex vertical align="flex-start">
            <Typography.Text>{PACK_COPY.signWait}</Typography.Text>
            <Typography.Link onClick={() => openSignIn()}>{PACK_COPY.signReopen}</Typography.Link>
          </Flex>
        </Flex>
      );
      footer = <Button onClick={() => setWaiting(false)}>{PACK_COPY.cancel}</Button>;
    } else {
      body = (
        <Flex vertical gap={12} align="flex-start">
          <Typography.Text type="secondary">{PACK_COPY.signLead}</Typography.Text>
          <Button
            type="primary"
            size="large"
            icon={<LoginOutlined />}
            loading={busy === 'sign-in'}
            disabled={Boolean(returnToProblem)}
            onClick={() => openSignIn()}
          >
            {PACK_COPY.signBtn}
          </Button>
        </Flex>
      );
      footer = cancel;
    }
    return {
      body: (
        <Flex vertical gap={12}>
          {stepTitle(PACK_COPY.signTitle)}
          {overHttp && (
            <Alert
              type={returnToProblem ? 'error' : 'warning'}
              showIcon
              message={
                returnToProblem
                  ? 'This Agor is served over http on a public address, so it can’t sign in to Agor Cloud. Serve it over HTTPS, or download an .agor file instead.'
                  : 'This Agor isn’t served over HTTPS, so the sign-in code comes back over an unencrypted connection on your network.'
              }
            />
          )}
          {cloudError && <Alert type="error" showIcon message={cloudError} />}
          {body}
        </Flex>
      ),
      footerStart: downloadLink,
      footer,
    };
  };

  // ----------------------------------------------------------------- Choose
  const renderChoose = () => {
    const sizeOf = (branchId: string) => {
      const row = allPreflight?.find((t) => t.branch_id === branchId);
      return row ? `${megabytes(exportEstimate([row], sessions, false).bytes)} MB` : '';
    };
    return {
      body: (
        <Flex vertical gap={12}>
          {stepTitle(PACK_COPY.chooseTitle)}
          <Typography.Text strong>{PACK_COPY.tmLabel}</Typography.Text>
          <Flex vertical gap={8} role="radiogroup" aria-label={PACK_COPY.tmLabel}>
            <OptionCard
              checked={who === 'all'}
              onSelect={() => setWho('all')}
              title={PACK_COPY.tmAll}
              description={fill(PACK_COPY.tmAllD, { names: listNames(teammates.map(nameOf)) })}
            />
            <OptionCard
              checked={who === 'pick'}
              onSelect={() => setWho('pick')}
              title={PACK_COPY.tmPick}
            />
          </Flex>
          {who === 'pick' && (
            <Flex
              vertical
              style={{
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: token.borderRadiusLG,
              }}
            >
              {teammates.map((branch, index) => (
                <Flex
                  key={branch.branch_id}
                  align="center"
                  gap={10}
                  style={{
                    padding: '8px 12px',
                    borderTop: index ? `1px solid ${token.colorBorderSecondary}` : undefined,
                  }}
                >
                  <Checkbox
                    checked={picked.includes(branch.branch_id)}
                    onChange={(event) =>
                      setPicked((prev) =>
                        event.target.checked
                          ? [...prev, branch.branch_id]
                          : prev.filter((id) => id !== branch.branch_id)
                      )
                    }
                  >
                    {emojiOf(branch)} {nameOf(branch)}
                  </Checkbox>
                  <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0 }}>
                    {boardOf(branch.branch_id)}
                  </Typography.Text>
                  <Typography.Text type="secondary">{sizeOf(branch.branch_id)}</Typography.Text>
                </Flex>
              ))}
            </Flex>
          )}
          <SessionHistoryPicker
            value={sessions}
            onChange={setSessions}
            preflight={preflight}
            includeOthers={false}
          />
          {preflightError && <Alert type="error" showIcon message={preflightError} />}
        </Flex>
      ),
      footerStart: (
        <Typography.Text type="secondary">
          {estimate &&
            fill(PACK_COPY.chooseTotal, {
              n: chosen.length,
              teammates: countLabel(chosen.length, PACK_COPY.cntTeammate, PACK_COPY.cntTeammates),
              mb: megabytes(estimate.bytes),
            })}
        </Typography.Text>
      ),
      footer: (
        <>
          <Button
            onClick={() => {
              setFileOnly(false);
              setStep(0);
            }}
          >
            {PACK_COPY.back}
          </Button>
          <Button type="primary" disabled={chosen.length === 0} onClick={() => setStep(2)}>
            {PACK_COPY.continue}
          </Button>
        </>
      ),
    };
  };

  // ------------------------------------------------------------------ Check
  const renderCheck = () => ({
    body: (
      <Flex vertical gap={12}>
        {stepTitle(PACK_COPY.checkTitle)}
        {check ? (
          <CheckReport
            check={check}
            mode="move"
            leaveOut={leaveOut}
            onLeaveOutChange={setLeaveOut}
          />
        ) : (
          <Skeleton active paragraph={{ rows: 4 }} />
        )}
        {!fileOnly && <div>{downloadLink}</div>}
      </Flex>
    ),
    footerStart: (
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        <InfoCircleOutlined /> {PACK_COPY.checkFoot}
      </Typography.Text>
    ),
    footer: (
      <>
        <Button onClick={() => setStep(1)}>{PACK_COPY.back}</Button>
        {fileOnly ? (
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={busy === 'download'}
            disabled={!check}
            onClick={download}
          >
            {PACK_COPY.expBtn}
          </Button>
        ) : (
          <Button
            type="primary"
            loading={busy === 'move'}
            disabled={!check || chosen.length === 0}
            onClick={startMove}
          >
            {moveLabel}
          </Button>
        )}
      </>
    ),
  });

  // ------------------------------------------------------------------- Move
  const renderMove = () => {
    if (!move) return { body: <Spin />, footer: null };
    if (lost) {
      return {
        body: (
          <Flex vertical gap={12}>
            {stepTitle(PACK_COPY.progTitle)}
            <Alert
              type="warning"
              showIcon
              message="Tracking stopped because Agor restarted. The import may have finished in Agor Cloud — open Agor Cloud to check, or start the move again."
            />
          </Flex>
        ),
        footer: (
          <>
            <Button onClick={onClose}>{PACK_COPY.doneClose}</Button>
            <Button
              onClick={() => {
                setLost(false);
                setMove(null);
                setStep(link ? 1 : 0);
              }}
            >
              Move again
            </Button>
            <Button
              type="primary"
              href={agorCloudWorkspacePageUrl(
                cloud?.console_url ?? AGOR_CLOUD.defaultConsoleUrl,
                move.workspace_url,
                '/ui/settings/import'
              )}
              target="_blank"
              rel="noopener noreferrer"
            >
              {PACK_COPY.doneOpen} <ExportOutlined />
            </Button>
          </>
        ),
      };
    }
    const percent = movePercent(move);
    const failed = move.items.filter((item) => item.status === 'failed').length;
    return {
      body: (
        <Flex vertical gap={12}>
          {stepTitle(PACK_COPY.progTitle)}
          <Flex align="center" gap={12}>
            <Progress
              percent={percent}
              showInfo={false}
              status={failed ? 'exception' : 'active'}
              style={{ flex: 1, margin: 0 }}
            />
            <Typography.Text strong>{percent}%</Typography.Text>
            {failed > 0 && move.status === 'finished' && (
              <Typography.Text type="danger">
                {fill(PACK_COPY.progToRetry, { n: failed })}
              </Typography.Text>
            )}
          </Flex>
          <Flex
            vertical
            style={{
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusLG,
            }}
          >
            {move.items.map((item, index) => {
              const active =
                item.status === 'exporting' ||
                item.status === 'sending' ||
                item.status === 'importing';
              return (
                <Flex
                  key={item.branch_id}
                  vertical
                  gap={4}
                  style={{
                    padding: '10px 12px',
                    borderTop: index ? `1px solid ${token.colorBorderSecondary}` : undefined,
                  }}
                >
                  <Flex align="center" gap={10}>
                    {item.status === 'done' ? (
                      <CheckCircleFilled style={{ color: token.colorSuccess }} />
                    ) : item.status === 'failed' ? (
                      <CloseCircleFilled style={{ color: token.colorError }} />
                    ) : active ? (
                      <LoadingOutlined style={{ color: token.colorPrimary }} />
                    ) : (
                      <ClockCircleOutlined style={{ color: token.colorTextTertiary }} />
                    )}
                    <Typography.Text strong style={{ whiteSpace: 'nowrap' }}>
                      {item.emoji ?? '🤖'} {item.display_name}
                    </Typography.Text>
                    {boardOf(item.branch_id) && (
                      <Typography.Text
                        type="secondary"
                        ellipsis
                        style={{ fontSize: token.fontSizeSM, maxWidth: 160 }}
                      >
                        › {boardOf(item.branch_id)}
                      </Typography.Text>
                    )}
                    {active ? (
                      <Progress
                        percent={
                          item.status === 'sending' && item.bytes_total
                            ? Math.floor((item.bytes_sent / item.bytes_total) * 100)
                            : item.status === 'importing'
                              ? 100
                              : 0
                        }
                        showInfo={false}
                        size="small"
                        status="active"
                        style={{ flex: 1, margin: 0 }}
                      />
                    ) : (
                      <span style={{ flex: 1 }} />
                    )}
                    {item.status === 'failed' ? (
                      <Button
                        size="small"
                        loading={busy === `retry:${item.branch_id}`}
                        onClick={() => retry(item.branch_id)}
                      >
                        {PACK_COPY.progRetry}
                      </Button>
                    ) : (
                      <Typography.Text type="secondary">
                        {item.status === 'done'
                          ? PACK_COPY.progDone
                          : item.status === 'waiting'
                            ? PACK_COPY.progWaiting
                            : PACK_COPY.progMoving}
                      </Typography.Text>
                    )}
                  </Flex>
                  {item.status === 'failed' && item.error && (
                    <Typography.Text type="danger" style={{ paddingInlineStart: 24 }}>
                      {item.error}
                    </Typography.Text>
                  )}
                </Flex>
              );
            })}
          </Flex>
        </Flex>
      ),
      footerStart: (
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          <InfoCircleOutlined /> {PACK_COPY.progClose}
        </Typography.Text>
      ),
      footer: (
        <>
          {move.status === 'finished' && moreButton}
          <Button onClick={onClose}>{PACK_COPY.doneClose}</Button>
        </>
      ),
    };
  };

  // ------------------------------------------------------------------- Done
  const done =
    step === 3 && move?.status === 'finished' && move.items.every((i) => i.status === 'done');
  const renderDone = () => {
    if (!move) return null;
    const names = move.items.map((item) => item.display_name);
    const one = names.length === 1;
    return (
      <Flex
        vertical
        align="center"
        gap={12}
        style={{ padding: '16px 8px 4px', textAlign: 'center' }}
      >
        <CheckCircleFilled style={{ fontSize: 44, color: token.colorSuccess }} />
        <Typography.Title level={5} style={{ margin: 0 }}>
          {fill(PACK_COPY.doneTitle, { names: listNames(names), are: one ? 'is' : 'are' })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {fill(PACK_COPY.doneSub, {
            they: one ? (names[0] ?? '') : 'They',
            keep: one ? 'keeps' : 'keep',
          })}
        </Typography.Text>
        {/* Switch over happens later, from the Agor Cloud card, once accounts are reconnected. */}
        <Flex gap={6} wrap justify="center">
          {move.items.map((item) => (
            <Tag key={item.branch_id} style={{ marginInlineEnd: 0 }}>
              {item.emoji ?? '🤖'} {item.display_name}
            </Tag>
          ))}
        </Flex>
        <Flex
          align="center"
          gap={10}
          style={{
            alignSelf: 'stretch',
            padding: '10px 12px',
            textAlign: 'start',
            borderRadius: token.borderRadiusLG,
            background: token.colorFillQuaternary,
          }}
        >
          <ArrowRightOutlined style={{ color: token.colorPrimary }} />
          <Typography.Text>{PACK_COPY.doneNext}</Typography.Text>
        </Flex>
      </Flex>
    );
  };

  /** Leave a finished move and start another (signed in, so from Choose). */
  const moreButton = (
    <Button
      type="link"
      onClick={() => {
        setMove(null);
        setStep(link ? 1 : 0);
      }}
    >
      Move more teammates
    </Button>
  );

  const view = done ? null : [renderSignIn, renderChoose, renderCheck, renderMove][step]?.();

  return (
    <AdaptiveSettingsModal
      open={open}
      onCancel={onClose}
      destroyOnHidden
      width={done ? 520 : step >= 2 ? 720 : 680}
      title={
        done ? null : (
          <Flex align="center" gap={8}>
            <CloudUploadOutlined style={{ color: token.colorPrimary }} />
            {PACK_COPY.moveTitle}
          </Flex>
        )
      }
      footer={
        done ? (
          <Flex justify="flex-end" gap={8}>
            {moreButton}
            <Button onClick={onClose}>{PACK_COPY.doneClose}</Button>
            <Button
              type="primary"
              href={move?.items.find((item) => item.open_url)?.open_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {PACK_COPY.doneOpen} <ExportOutlined />
            </Button>
          </Flex>
        ) : (
          <Flex align="center" justify="space-between" gap={8}>
            <div style={{ minWidth: 0, flex: 1, textAlign: 'start' }}>{view?.footerStart}</div>
            <Flex gap={8}>{view?.footer}</Flex>
          </Flex>
        )
      }
    >
      {done ? (
        renderDone()
      ) : (
        <Flex vertical gap={16}>
          <Steps
            size="small"
            current={step}
            items={STEP_TITLES.map((title) => ({ title }))}
            style={{ marginTop: 8 }}
          />
          {view?.body}
        </Flex>
      )}
    </AdaptiveSettingsModal>
  );
};
