/**
 * Inbound trigger URL for one schedule: enable / rotate / disable, and show the
 * token exactly once after it is issued. The server enforces who may manage it
 * (the schedule owner, same as run-now); `canManage` only hides the buttons.
 */

import {
  type ScheduleTriggerTokenAction,
  type ScheduleTriggerTokenResult,
  scheduleTriggerPath,
} from '@agor/core/types';
import type { AgorClient, Schedule } from '@agor-live/client';
import { CopyOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Popconfirm, Space, Typography } from 'antd';
import { useState } from 'react';
import { getDaemonUrl } from '@/config/daemon';
import { copyToClipboard } from '../../utils/clipboard';
import { formatActionError } from '../../utils/connectionErrors';
import { useThemedMessage } from '../../utils/message';

const { Text, Paragraph } = Typography;

export interface ScheduleTriggerSectionProps {
  client: AgorClient | null;
  schedule: Schedule;
  /** Whether the caller may manage the token (schedule owner). */
  canManage: boolean;
}

export const ScheduleTriggerSection: React.FC<ScheduleTriggerSectionProps> = ({
  client,
  schedule,
  canManage,
}) => {
  const { showError, showSuccess } = useThemedMessage();
  const [enabled, setEnabled] = useState(schedule.trigger_enabled);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [pending, setPending] = useState<ScheduleTriggerTokenAction | null>(null);
  const triggerUrl = `${getDaemonUrl()}${scheduleTriggerPath(schedule.schedule_id)}`;

  const run = async (action: ScheduleTriggerTokenAction) => {
    if (!client) return;
    setPending(action);
    try {
      const result = (await client
        .service(`schedules/${schedule.schedule_id}/trigger-token`)
        .create({ action })) as ScheduleTriggerTokenResult;
      setEnabled(result.trigger_enabled);
      setIssuedToken(result.token ?? null);
      if (action === 'disable') showSuccess('Trigger URL turned off.');
    } catch (err) {
      const verb = action === 'disable' ? 'turn off' : action;
      showError(formatActionError(`${verb} the trigger URL`, err, { idempotent: false }));
    } finally {
      setPending(null);
    }
  };

  const copy = async (text: string, label: string) => {
    if (await copyToClipboard(text)) showSuccess(`${label} copied.`);
    else showError(`Couldn't copy. Select the ${label.toLowerCase()} and copy it manually.`);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <Text strong>Trigger URL</Text>
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>
        Let another system start this schedule with an HTTP request, for example when there is new
        work to do. The request body is ignored. If a run can't start yet, one follow-up run is
        queued (see Concurrency under Schedule Settings).
      </Paragraph>

      {enabled ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text code copyable={{ text: triggerUrl }} style={{ wordBreak: 'break-all' }}>
            POST {triggerUrl}
          </Text>
          {schedule.last_triggered_at ? (
            <Text type="secondary">
              Last triggered {new Date(schedule.last_triggered_at).toLocaleString()}
            </Text>
          ) : null}
          {issuedToken ? (
            <Alert
              type="warning"
              showIcon
              title="Copy the token now"
              description={
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <span>
                    This is the only time it's shown. Anyone with it can start this schedule as its
                    owner, so store it as a secret.
                  </span>
                  <Input.TextArea
                    aria-label="Trigger token"
                    value={issuedToken}
                    readOnly
                    autoSize
                    style={{ fontFamily: 'monospace' }}
                  />
                  <Space wrap>
                    <Button icon={<CopyOutlined />} onClick={() => copy(issuedToken, 'Token')}>
                      Copy token
                    </Button>
                    <Button
                      icon={<CopyOutlined />}
                      onClick={() =>
                        copy(
                          `curl -X POST -H "Authorization: Bearer ${issuedToken}" ${triggerUrl}`,
                          'Command'
                        )
                      }
                    >
                      Copy curl command
                    </Button>
                    <Button type="link" onClick={() => setIssuedToken(null)}>
                      Done
                    </Button>
                  </Space>
                </Space>
              }
            />
          ) : null}
          {canManage ? (
            <Space>
              <Popconfirm
                title="Rotate the token?"
                description="The current token stops working right away."
                onConfirm={() => run('rotate')}
                okText="Rotate"
              >
                <Button loading={pending === 'rotate'} disabled={pending !== null}>
                  Rotate token
                </Button>
              </Popconfirm>
              <Popconfirm
                title="Turn off the trigger URL?"
                description="Requests with the current token will be rejected."
                onConfirm={() => run('disable')}
                okText="Turn off"
                okButtonProps={{ danger: true }}
              >
                <Button danger loading={pending === 'disable'} disabled={pending !== null}>
                  Turn off
                </Button>
              </Popconfirm>
            </Space>
          ) : null}
        </Space>
      ) : canManage ? (
        <Button loading={pending === 'enable'} onClick={() => run('enable')}>
          Turn on trigger URL
        </Button>
      ) : (
        <Text type="secondary">Off. Only the schedule's owner can turn it on.</Text>
      )}
    </div>
  );
};
