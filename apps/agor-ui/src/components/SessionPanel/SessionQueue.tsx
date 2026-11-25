import type { AgorClient, Session, Task, TaskID } from '@agor-live/client';
import {
  CloseOutlined,
  CopyOutlined,
  DownOutlined,
  EditOutlined,
  EllipsisOutlined,
  RightOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { Alert, Button, ConfigProvider, Flex, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useCanHover } from '../../hooks/useCanHover';
import { useComposerFocused } from '../../hooks/useComposerFocus';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { copyToClipboard } from '../../utils/clipboard';
import { formatActionError } from '../../utils/connectionErrors';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { useThemedMessage } from '../../utils/message';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';
import { ComposerMenu, ComposerMenuRow } from './ComposerMenu';
import { moveQueuedTask, type QueueMove } from './composerState';

export interface SessionQueueProps {
  client: AgorClient | null;
  session: Pick<Session, 'session_id' | 'status'>;
  queuedTasks: Task[];
  isRunning: boolean;
  /** Stops the current turn, so the queue head runs next. */
  onStop: () => Promise<void> | void;
  /** Puts a queued message's text back in the composer. */
  onEdit: (text: string) => void;
}

/** Queued messages above the composer: folded to "2 queued", rows with send, edit and reorder. */
export function SessionQueue({
  client,
  session,
  queuedTasks,
  isRunning,
  onStop,
  onEdit,
}: SessionQueueProps) {
  const { token } = theme.useToken();
  const isMobile = useIsMobileViewport();
  const canHover = useCanHover();
  const composerFocused = useComposerFocused();
  const { showSuccess, showError } = useThemedMessage();
  const [expanded, setExpanded] = React.useState(false);
  const [activeRow, setActiveRow] = React.useState<TaskID | null>(null);
  const [busyTaskId, setBusyTaskId] = React.useState<TaskID | null>(null);
  const [resumeInFlight, setResumeInFlight] = React.useState(false);
  const [menuTaskId, setMenuTaskId] = React.useState<TaskID | null>(null);
  const heldByFailure = queuedTasks.length > 0 && session.status === 'failed';
  // Phones fold the queue while the keyboard is up.
  const open = expanded && !(isMobile && composerFocused);

  if (queuedTasks.length === 0) return null;

  const resumeQueue = async () => {
    if (!client || resumeInFlight) return;
    setResumeInFlight(true);
    try {
      await client.service('sessions').patch(session.session_id, { ready_for_prompt: true });
      showSuccess('Resuming queued prompts');
    } catch (error) {
      showError(formatActionError('resume the queue', error, { idempotent: true }));
    } finally {
      setResumeInFlight(false);
    }
  };

  const run = async (task: Task, action: string, work: () => Promise<void>) => {
    if (!client || busyTaskId) return;
    setBusyTaskId(task.task_id);
    try {
      await work();
    } catch (error) {
      showError(formatActionError(action, error, { idempotent: true }));
    } finally {
      setBusyTaskId(null);
    }
  };

  const reorder = async (task: Task, move: QueueMove) => {
    const order = queuedTasks.map((queued) => queued.task_id);
    const next = moveQueuedTask(order, task.task_id, move);
    if (!next || !client) return;
    await client.service('tasks').reorderQueued({
      session_id: session.session_id,
      expected_task_ids: order,
      task_ids: next,
    });
  };

  const remove = (task: Task) => client?.service('tasks').remove(task.task_id);

  const sendNow = (task: Task) =>
    run(task, 'send the message now', async () => {
      // Move first, then stop: the turn's end drains the queue head.
      await reorder(task, 'front');
      if (isRunning) await onStop();
      else if (heldByFailure) await resumeQueue();
    });

  const edit = (task: Task) =>
    run(task, 'edit the queued message', async () => {
      await remove(task);
      onEdit(task.full_prompt);
    });

  const fromMenu = (action: () => unknown) => () => {
    setMenuTaskId(null);
    void action();
  };
  const rowMenu = (task: Task, index: number) => {
    const n = index + 1;
    return (
      <>
        <ComposerMenuRow
          label="Copy"
          ariaLabel={`Copy, message ${n}`}
          icon={<CopyOutlined />}
          onClick={fromMenu(async () => {
            await copyToClipboard(task.full_prompt);
            showSuccess('Message copied to clipboard');
          })}
        />
        <ComposerMenuRow
          label="Move up"
          ariaLabel={`Move up, message ${n}`}
          icon={<UpOutlined />}
          disabled={index === 0}
          onClick={fromMenu(() => run(task, 'move the queued message', () => reorder(task, 'up')))}
        />
        <ComposerMenuRow
          label="Move down"
          ariaLabel={`Move down, message ${n}`}
          icon={<DownOutlined />}
          disabled={index === queuedTasks.length - 1}
          onClick={fromMenu(() =>
            run(task, 'move the queued message', () => reorder(task, 'down'))
          )}
        />
      </>
    );
  };

  const actionSize = isMobile ? MOBILE_TOUCH_TARGET : token.controlHeight;
  const iconButtonStyle: React.CSSProperties = { minWidth: actionSize, height: actionSize };

  return (
    <section
      aria-label="Queued messages"
      // Folded, the queue is one quiet line; only the open list gets the card.
      style={
        open
          ? {
              ...glassSurfaceStyle(token, 0.7),
              borderWidth: token.lineWidth,
              borderStyle: token.lineType,
              borderColor: token.colorBorder,
              borderRadius: token.borderRadius * 2,
              marginBottom: token.marginXS,
              padding: token.paddingXXS,
            }
          : { paddingInline: token.paddingXS, marginBottom: token.marginXXS }
      }
    >
      <Flex align="center" gap={token.marginXS}>
        <ConfigProvider
          theme={{ components: { Button: { textHoverBg: token.colorFillTertiary } } }}
        >
          <Button
            type="text"
            size="small"
            aria-expanded={open}
            onClick={() => setExpanded((value) => !value)}
            icon={open ? <DownOutlined aria-hidden /> : <RightOutlined aria-hidden />}
            iconPlacement="end"
            style={{
              height: isMobile ? MOBILE_TOUCH_TARGET : token.controlHeight,
              paddingInline: token.paddingXXS,
              fontSize: token.fontSizeSM,
              color: token.colorTextSecondary,
            }}
          >
            {`${queuedTasks.length} queued`}
          </Button>
        </ConfigProvider>
        {heldByFailure && (
          <Button
            size="small"
            type="primary"
            loading={resumeInFlight}
            disabled={!client}
            onClick={resumeQueue}
            style={{ marginInlineStart: 'auto' }}
          >
            Resume queue
          </Button>
        )}
      </Flex>
      {heldByFailure && open && (
        <Alert
          type="warning"
          showIcon
          style={{ margin: token.marginXXS }}
          message="Queue paused by failed session"
          description="Queued prompts are preserved. Resume the queue to run the next prompt without copy/paste."
        />
      )}
      {open && (
        <ol
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            maxHeight: isMobile ? '25dvh' : '40vh',
            overflowY: 'auto',
          }}
        >
          {queuedTasks.map((task, index) => {
            const n = index + 1;
            // Touch shows every action; desktop keeps the first row's, and reveals the rest on hover or focus.
            const showIcons = !canHover || isMobile || index === 0 || activeRow === task.task_id;
            const busy = busyTaskId === task.task_id;
            return (
              <li
                key={task.task_id}
                onMouseEnter={() => setActiveRow(task.task_id)}
                onMouseLeave={() => setActiveRow(null)}
                onFocus={() => setActiveRow(task.task_id)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setActiveRow(null);
                  }
                }}
                style={{
                  display: 'flex',
                  flexWrap: isMobile ? 'wrap' : 'nowrap',
                  alignItems: 'center',
                  gap: token.marginXXS,
                  paddingInlineStart: token.paddingXS,
                  minHeight: actionSize,
                }}
              >
                <Typography.Paragraph
                  ellipsis={{ rows: isMobile ? 2 : 1 }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    flexBasis: isMobile ? '100%' : undefined,
                    margin: 0,
                  }}
                >
                  <Typography.Text type="secondary">{`${n}. `}</Typography.Text>
                  {task.full_prompt}
                </Typography.Paragraph>
                <Flex
                  align="center"
                  gap={token.marginXXS}
                  style={{ flexShrink: 0, marginInlineStart: 'auto' }}
                >
                  {heldByFailure && index === 0 && (
                    <Button
                      type="link"
                      loading={resumeInFlight}
                      disabled={!client}
                      onClick={resumeQueue}
                      style={{ height: actionSize }}
                    >
                      Run next
                    </Button>
                  )}
                  <Button
                    type="text"
                    aria-label={`Send now, message ${n}`}
                    loading={busy}
                    disabled={!client || (busyTaskId !== null && !busy)}
                    onClick={() => sendNow(task)}
                    style={{ height: actionSize }}
                  >
                    Send now
                  </Button>
                  {/* Hidden icons stay in the tab order, so focus reveals them. */}
                  <Flex align="center" gap={token.marginXXS} style={{ opacity: showIcons ? 1 : 0 }}>
                    <Tooltip title="Edit in composer">
                      <Button
                        type="text"
                        aria-label={`Edit in composer, message ${n}`}
                        icon={<EditOutlined />}
                        disabled={!client || busyTaskId !== null}
                        onClick={() => edit(task)}
                        style={iconButtonStyle}
                      />
                    </Tooltip>
                    <Tooltip title="Remove from queue">
                      <Button
                        type="text"
                        aria-label={`Remove from queue, message ${n}`}
                        icon={<CloseOutlined />}
                        disabled={!client || busyTaskId !== null}
                        onClick={() =>
                          run(task, 'remove the queued message', async () => {
                            await remove(task);
                          })
                        }
                        style={iconButtonStyle}
                      />
                    </Tooltip>
                    {/* Phones get a bottom sheet, like every composer menu; desktop a popover. */}
                    <ComposerMenu
                      sheet={isMobile}
                      title={`Message ${n}`}
                      open={menuTaskId === task.task_id}
                      onOpenChange={(next) => setMenuTaskId(next ? task.task_id : null)}
                      content={rowMenu(task, index)}
                    >
                      <Button
                        type="text"
                        aria-label={`More actions, message ${n}`}
                        aria-haspopup="dialog"
                        aria-expanded={menuTaskId === task.task_id}
                        icon={<EllipsisOutlined />}
                        disabled={!client || busyTaskId !== null}
                        onClick={isMobile ? () => setMenuTaskId(task.task_id) : undefined}
                        style={iconButtonStyle}
                      />
                    </ComposerMenu>
                  </Flex>
                </Flex>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
