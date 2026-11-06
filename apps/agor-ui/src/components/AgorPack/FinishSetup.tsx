import type { UpdateUserInput } from '@agor/core/types';
import type { AgorClient, Branch, EnvVarScope, Schedule, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import {
  ApiOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  KeyOutlined,
  LinkOutlined,
  MessageOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Drawer, Flex, Progress, Switch, Typography, theme } from 'antd';
import { useState } from 'react';
import { useMCPCatalogModal } from '../../contexts/MCPCatalogModalContext';
import { useAuthenticatedAuthorityScope } from '../../hooks/useAuthorityOperationGuard';
import { useSettingsRoute } from '../../hooks/useSettingsRoute';
import { useThemedMessage } from '../../utils/message';
import { EnvVarEditor, type EnvVarEntry } from '../EnvVarEditor';
import { Tag } from '../Tag';
import { fill, PACK_COPY } from './packCopy';
import { type FinishSetupItem, type FinishSetupState, useFinishSetup } from './useFinishSetup';

/** "On" / "Waiting for Notion" / "Paused until you switch over". */
export function scheduleStateLine(
  schedule: Schedule,
  setup: Pick<FinishSetupState, 'waitingFor'>
): { text: string; tone: 'success' | 'warning' | 'secondary' } {
  if (schedule.enabled) return { text: 'On', tone: 'success' };
  const app = setup.waitingFor(schedule);
  if (app) return { text: fill(PACK_COPY.schedWaits, { app }), tone: 'warning' };
  return { text: PACK_COPY.schedPaused, tone: 'secondary' };
}

/** The lead names schedules only when there are some to unblock. */
export function finishSetupLead(setup: Pick<FinishSetupState, 'name' | 'schedules'>): string {
  return fill(setup.schedules.length ? PACK_COPY.fsLead : PACK_COPY.fsLeadNoSchedules, {
    name: setup.name,
  });
}

const ICONS: Record<FinishSetupItem['kind'], React.ReactNode> = {
  account: <RobotOutlined />,
  mcp: <ApiOutlined />,
  env: <KeyOutlined />,
  channel: <MessageOutlined />,
};

export interface FinishSetupProps {
  branch: Branch;
  client?: AgorClient | null;
  currentUser?: User | null;
}

/**
 * Finish setup for an imported teammate: a card (on its board and in the
 * teammate panel) that opens the right-side panel listing what to reconnect.
 * Renders nothing for teammates that weren't imported or are all set.
 */
export const FinishSetupCard: React.FC<FinishSetupProps & { style?: React.CSSProperties }> = ({
  branch,
  client,
  currentUser,
  style,
}) => {
  const { token } = theme.useToken();
  const setup = useFinishSetup(branch, client, currentUser);
  const [open, setOpen] = useState(false);
  if (!setup || setup.total === 0 || (setup.done === setup.total && !open)) return null;
  return (
    <>
      <Card
        size="small"
        style={{
          background: token.colorPrimaryBg,
          borderColor: token.colorPrimaryBorder,
          ...style,
        }}
        styles={{ body: { padding: 12 } }}
      >
        <Flex vertical gap={8}>
          <Flex align="center" justify="space-between" gap={8}>
            <Typography.Text strong>
              <LinkOutlined /> {PACK_COPY.fsTitle}
            </Typography.Text>
            <Button size="small" type="primary" onClick={() => setOpen(true)}>
              {PACK_COPY.fsOpen}
            </Button>
          </Flex>
          <Typography.Text type="secondary">{finishSetupLead(setup)}</Typography.Text>
          <Progress
            percent={Math.round((setup.done / setup.total) * 100)}
            showInfo={false}
            size="small"
          />
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {fill(PACK_COPY.fsCount, { n: setup.done, total: setup.total })}
          </Typography.Text>
        </Flex>
      </Card>
      <FinishSetupPanel
        open={open}
        onClose={() => setOpen(false)}
        setup={setup}
        client={client}
        currentUser={currentUser}
      />
    </>
  );
};

function FinishSetupPanel({
  open,
  onClose,
  setup,
  client,
  currentUser,
}: {
  open: boolean;
  onClose: () => void;
  setup: FinishSetupState;
  client?: AgorClient | null;
  currentUser?: User | null;
}) {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const catalog = useMCPCatalogModal();
  const { openSettings } = useSettingsRoute();
  const authority = useAuthenticatedAuthorityScope(
    client ?? null,
    currentUser ? `${currentUser.user_id}:${currentUser.role}` : null
  );
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedEnv, setSavedEnv] = useState<Record<string, EnvVarEntry>>({});
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

  const userEnv = {
    ...((currentUser?.env_vars as Record<string, EnvVarEntry> | undefined) ?? {}),
    ...savedEnv,
  };
  const envItems = setup.items.filter((item) => item.kind === 'env');
  const envVars = Object.fromEntries(
    envItems.map((item) => [
      item.envName as string,
      userEnv[item.envName as string] ??
        ({ set: false, scope: (item.envScope ?? 'global') as EnvVarScope } as never),
    ])
  ) as Record<string, EnvVarEntry>;

  const saveEnv = async (key: string, value: string, scope: EnvVarScope) => {
    if (!client || !currentUser) return;
    setSaving((prev) => ({ ...prev, [key]: true }));
    try {
      const updates: UpdateUserInput = {
        env_vars: { [key]: value },
        env_var_scopes: { [key]: scope },
      };
      // The daemon encrypts plaintext env vars; the client types patch as Partial<User>.
      await client.service('users').patch(currentUser.user_id, updates as Partial<User>);
      setSavedEnv((prev) => ({ ...prev, [key]: { set: true, scope, resource_id: null } }));
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  };

  const toggleSchedule = async (schedule: Schedule, enabled: boolean) => {
    if (!client) return;
    try {
      setup.setSchedule(
        (await client.service('schedules').patch(schedule.schedule_id, { enabled })) as Schedule
      );
    } catch (error) {
      showError(
        `Could not update schedule: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const reconnect = (item: FinishSetupItem) => {
    if (item.kind === 'account') {
      openSettings('agentic-tools');
    } else if (item.kind === 'channel') {
      openSettings('gateway');
    } else if (item.kind === 'mcp' && item.catalogEntryName && catalog) {
      catalog.openCatalogEntry({
        entryName: item.catalogEntryName,
        returnTo: PACK_COPY.fsTitle,
        onConnected: () => undefined,
      });
    } else {
      catalog?.openCatalog();
    }
  };

  const row = (item: FinishSetupItem, action: React.ReactNode) => (
    <Card key={item.key} size="small" styles={{ body: { padding: 12 } }}>
      <Flex gap={12} align="flex-start">
        <Flex
          align="center"
          justify="center"
          style={{
            width: 32,
            height: 32,
            flexShrink: 0,
            borderRadius: token.borderRadius,
            background: token.colorFillTertiary,
          }}
        >
          {ICONS[item.kind]}
        </Flex>
        <Flex vertical style={{ flex: 1, minWidth: 0 }}>
          <Flex align="center" gap={6}>
            <Typography.Text strong>{item.label}</Typography.Text>
            {item.kind === 'channel' && <Tag color="purple">{PACK_COPY.fsAdmin}</Tag>}
          </Flex>
          {item.usedBy.map((line) => (
            <Typography.Text key={line} type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {line}
            </Typography.Text>
          ))}
        </Flex>
        {item.done ? (
          <Tag color="success" icon={<CheckOutlined />}>
            {PACK_COPY.fsConnected}
          </Tag>
        ) : (
          action
        )}
      </Flex>
    </Card>
  );

  const appItems = setup.items.filter((item) => item.kind === 'account' || item.kind === 'mcp');
  const channelItems = setup.items.filter((item) => item.kind === 'channel');

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      width={420}
      mask={false}
      title={
        <span>
          <LinkOutlined /> {PACK_COPY.fsTitle}
        </span>
      }
    >
      <Flex vertical gap={12}>
        <Typography.Text>{finishSetupLead(setup)}</Typography.Text>
        <Flex align="center" gap={8}>
          <Progress
            percent={setup.total ? Math.round((setup.done / setup.total) * 100) : 100}
            showInfo={false}
            size="small"
            style={{ flex: 1, margin: 0 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {fill(PACK_COPY.fsCount, { n: setup.done, total: setup.total })}
          </Typography.Text>
        </Flex>
        {setup.total > 0 && setup.done === setup.total && (
          <Alert type="success" showIcon message={`All ${setup.total} apps are reconnected.`} />
        )}

        {appItems.map((item) =>
          row(
            item,
            <Button size="small" type="primary" onClick={() => reconnect(item)}>
              {PACK_COPY.fsConnect}
            </Button>
          )
        )}

        {envItems.length > 0 && (
          <Card size="small" styles={{ body: { padding: 12 } }}>
            <Flex vertical gap={8}>
              {envItems.map((item) => (
                <Flex key={item.key} vertical>
                  <Typography.Text strong>{item.label}</Typography.Text>
                  {item.usedBy.map((line) => (
                    <Typography.Text
                      key={line}
                      type="secondary"
                      style={{ fontSize: token.fontSizeSM }}
                    >
                      {line}
                    </Typography.Text>
                  ))}
                </Flex>
              ))}
              <EnvVarEditor
                envVars={envVars}
                onSave={saveEnv}
                onDelete={async () => undefined}
                loading={saving}
                hideDescription
                compact
                identityKey={authority.identityKey}
                operationScope={authority.operationScope}
              />
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {PACK_COPY.fsSecure}
              </Typography.Text>
            </Flex>
          </Card>
        )}

        {channelItems.length > 0 && (
          <>
            <Typography.Text type="secondary">{PACK_COPY.fsSlackHead}</Typography.Text>
            {channelItems.map((item) =>
              row(
                { ...item, usedBy: [...item.usedBy, PACK_COPY.fsSlackNeeds] },
                isAdmin ? (
                  <Button size="small" onClick={() => reconnect(item)}>
                    {PACK_COPY.fsConnect}
                  </Button>
                ) : null
              )
            )}
          </>
        )}

        {setup.schedules.length > 0 && (
          <>
            <Typography.Text type="secondary">{PACK_COPY.fsSchedHead}</Typography.Text>
            {setup.schedules.map((schedule) => {
              const state = scheduleStateLine(schedule, setup);
              return (
                <Flex key={schedule.schedule_id} align="center" gap={8}>
                  <Flex vertical style={{ flex: 1, minWidth: 0 }}>
                    <Typography.Text>{schedule.name}</Typography.Text>
                    <Typography.Text
                      type={state.tone === 'secondary' ? 'secondary' : state.tone}
                      style={{ fontSize: token.fontSizeSM }}
                    >
                      {state.text}
                    </Typography.Text>
                  </Flex>
                  <Switch
                    size="small"
                    checked={schedule.enabled}
                    aria-label={`Turn on ${schedule.name}`}
                    onChange={(enabled) => toggleSchedule(schedule, enabled)}
                  />
                </Flex>
              );
            })}
          </>
        )}
      </Flex>
    </Drawer>
  );
}

/** An imported teammate's schedules with their state (teammate panel). */
export const TeammateSchedules: React.FC<FinishSetupProps> = ({ branch, client, currentUser }) => {
  const { token } = theme.useToken();
  const setup = useFinishSetup(branch, client, currentUser);
  if (!setup || setup.schedules.length === 0) return null;
  return (
    <Flex vertical gap={6} style={{ paddingTop: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {PACK_COPY.fsSchedHead} {setup.schedules.length}
      </Typography.Text>
      {setup.schedules.map((schedule) => {
        const state = scheduleStateLine(schedule, setup);
        return (
          <Flex key={schedule.schedule_id} gap={8} align="flex-start">
            <ClockCircleOutlined
              style={{
                marginTop: 4,
                color: state.tone === 'warning' ? token.colorWarning : token.colorTextTertiary,
              }}
            />
            <Flex vertical style={{ minWidth: 0 }}>
              <Typography.Text ellipsis>{schedule.name}</Typography.Text>
              <Typography.Text
                type={state.tone === 'secondary' ? 'secondary' : state.tone}
                style={{ fontSize: token.fontSizeSM }}
              >
                {state.text}
              </Typography.Text>
            </Flex>
          </Flex>
        );
      })}
    </Flex>
  );
};
