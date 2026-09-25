import type { Session } from '@agor-live/client';
import { isSessionExecuting, SessionStatus } from '@agor-live/client';
import { ExclamationCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import type { GlobalToken } from 'antd';
import { theme } from 'antd';
import type React from 'react';
import { ToolIcon } from '../ToolIcon';

/**
 * Shared row presentation for session lists (branch trees, the Sessions tab):
 * one logo column, one title treatment, and one trailing status mark, so the
 * surfaces cannot drift apart.
 */

export const SESSION_ROW_LOGO_SIZE = 16;
const SESSION_STATUS_DOT_SIZE = 6;

export const isSessionFailed = (session: Pick<Session, 'status'>): boolean =>
  session.status === SessionStatus.FAILED;

/** A failed row that is not running again gets the error tint and failure mark. */
export const isSessionRowFailed = (session: Session): boolean =>
  isSessionFailed(session) && !isSessionExecuting(session);

/** Read rows recede one gentle step; active, failed, timed-out, ready and selected rows stay full strength. */
export const isSessionRowRead = (session: Session, selected: boolean): boolean =>
  !(
    isSessionExecuting(session) ||
    isSessionFailed(session) ||
    session.status === SessionStatus.TIMED_OUT ||
    session.ready_for_prompt ||
    selected
  );

type StatusMarkKind = 'running' | 'input' | 'waiting' | 'timed-out' | 'failed' | 'ready';

const STATUS_MARK_LABELS: Record<StatusMarkKind, string> = {
  running: 'Running',
  input: 'Awaiting input',
  waiting: 'Waiting',
  'timed-out': 'Timed out',
  failed: 'Latest task failed',
  ready: 'Ready for prompt',
};

/** Per-status wording for the waiting family, so the mark's name says what it waits on. */
const WAITING_LABELS: Partial<Record<Session['status'], string>> = {
  [SessionStatus.AWAITING_PERMISSION]: 'Awaiting permission',
  [SessionStatus.STOPPING]: 'Stopping',
};

/**
 * Tones follow getSessionStatusTone: running spins green, awaiting input (processing)
 * pulses in the primary color, awaiting permission/stopping (warning) pulse amber.
 */
function getStatusMarkKind(session: Session): StatusMarkKind | null {
  if (session.status === SessionStatus.RUNNING) return 'running';
  if (session.status === SessionStatus.AWAITING_INPUT) return 'input';
  if (isSessionExecuting(session)) return 'waiting';
  if (isSessionFailed(session)) return 'failed';
  if (session.status === SessionStatus.TIMED_OUT) return 'timed-out';
  if (session.ready_for_prompt) return 'ready';
  return null;
}

function getStatusMarkLabel(session: Session, kind: StatusMarkKind): string {
  return kind === 'waiting'
    ? (WAITING_LABELS[session.status] ?? STATUS_MARK_LABELS.waiting)
    : STATUS_MARK_LABELS[kind];
}

/** Row fill: failed rows tint the whole row; selection is a neutral fill. */
export function getSessionRowFill(
  token: GlobalToken,
  { failed, selected }: { failed: boolean; selected: boolean }
): string {
  if (failed) {
    // Hover is nearly identical to Bg in the light theme; Active reads as selected.
    return selected ? token.colorErrorBgActive : token.colorErrorBg;
  }
  return selected ? token.colorFillSecondary : 'transparent';
}

/** Single-line title that ellipsizes; parents are a touch heavier to anchor structure. */
export function getSessionRowTitleStyle(
  token: GlobalToken,
  { read, parent = false, hug = false }: { read: boolean; parent?: boolean; hug?: boolean }
): React.CSSProperties {
  return {
    fontSize: 13,
    fontWeight: parent ? 500 : undefined,
    color: read ? token.colorTextSecondary : undefined,
    flex: hug ? '0 1 auto' : 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
}

export const SessionRowLogo: React.FC<{ tool: string }> = ({ tool }) => (
  <ToolIcon tool={tool} size={SESSION_ROW_LOGO_SIZE} bordered={false} />
);

/**
 * Trailing status: spinner while running (green); pulsing dot while awaiting input
 * (primary) or awaiting permission/stopping (amber); amber dot when timed out,
 * primary dot when ready, exclamation when failed.
 */
export const SessionStatusMark: React.FC<{ session: Session }> = ({ session }) => {
  const { token } = theme.useToken();
  const kind = getStatusMarkKind(session);
  if (!kind) return null;
  if (kind === 'failed') {
    // A shape, not just a color, separates failure from the ready dot.
    return (
      <ExclamationCircleOutlined
        role="img"
        aria-label="Latest task failed"
        title="Latest task failed"
        style={{ color: token.colorErrorText, fontSize: token.fontSizeSM, flex: '0 0 auto' }}
      />
    );
  }
  if (kind === 'running') {
    // Working, not waiting on the user: a spinner reads as progress where a dot reads as state.
    return (
      <LoadingOutlined
        spin
        role="img"
        aria-label="Running"
        title="Running"
        style={{ color: token.colorSuccess, fontSize: token.fontSizeSM, flex: '0 0 auto' }}
      />
    );
  }
  const label = getStatusMarkLabel(session, kind);
  const pulsing = kind === 'input' || kind === 'waiting';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={pulsing ? 'status-dot-run' : undefined}
      style={{
        display: 'inline-block',
        width: SESSION_STATUS_DOT_SIZE,
        height: SESSION_STATUS_DOT_SIZE,
        borderRadius: '50%',
        flex: '0 0 auto',
        background: kind === 'ready' || kind === 'input' ? token.colorPrimary : token.colorWarning,
      }}
    />
  );
};

/** Accessible-name suffix for state that rows show only visually. */
export function getSessionRowStateLabel(session: Session): string | null {
  const kind = getStatusMarkKind(session);
  return kind ? getStatusMarkLabel(session, kind).toLowerCase() : null;
}
