import {
  buildDiscordInstallUrl,
  buildDiscordRecommendedApplicationSettings,
  DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES,
  DISCORD_BOT_TOKEN_MAX_BYTES,
  DISCORD_GATEWAY_INTENT_NAMES,
  DISCORD_LAUNCH_PERMISSION_NAMES,
  DISCORD_LAUNCH_PERMISSIONS_DECIMAL,
  DISCORD_USER_MAP_MAX_ENTRIES,
  isDiscordSnowflake,
} from '@agor/core/gateway/discord-setup';
import type {
  GatewayConnectionTestResult,
  GatewayDiscordApplicationSettingsApplyResult,
  User,
} from '@agor-live/client';
import { GATEWAY_REDACTED_SENTINEL } from '@agor-live/client';
import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  type FormInstance,
  Input,
  Radio,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import {
  DISCORD_GATEWAY_FORM_DEFAULTS,
  validateDiscordAllowedParentIds,
  validateDiscordUserMapRows,
} from './discordGatewayForm';
import { UserSelect } from './UserSelect';

const DISCORD_DEVELOPER_APPLICATIONS_URL = 'https://discord.com/developers/applications';

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export const DiscordGatewaySetup: React.FC<{
  form: FormInstance;
  mode: 'create' | 'edit';
  step: 'configure' | 'portal' | 'edit';
  userById: Map<string, User>;
  tokenStored: boolean;
  channelEnabled: boolean;
  setupDirty: boolean;
  testLoading: boolean;
  testResult: GatewayConnectionTestResult | null;
  applyLoading: boolean;
  applyResult: GatewayDiscordApplicationSettingsApplyResult | null;
  onTest: () => void;
  onApply: () => void;
}> = ({
  form,
  mode,
  step,
  userById,
  tokenStored,
  channelEnabled,
  setupDirty,
  testLoading,
  testResult,
  applyLoading,
  applyResult,
  onTest,
  onApply,
}) => {
  const [copied, setCopied] = useState(false);
  const applicationId = Form.useWatch('discord_application_id', form) as string | undefined;
  const guildId = Form.useWatch('discord_guild_id', form) as string | undefined;
  const alignUsers = Form.useWatch('align_discord_users', form) !== false;
  const mapRows = (Form.useWatch('discord_user_map', form) as unknown[] | undefined) ?? [];
  const installUrl = useMemo(
    () =>
      isDiscordSnowflake(applicationId) && isDiscordSnowflake(guildId)
        ? buildDiscordInstallUrl(applicationId, guildId)
        : null,
    [applicationId, guildId]
  );
  const preview = useMemo(
    () =>
      JSON.stringify(
        {
          flags: ['GATEWAY_MESSAGE_CONTENT_LIMITED'],
          ...buildDiscordRecommendedApplicationSettings(),
        },
        null,
        2
      ),
    []
  );

  const configuration = (
    <div style={{ display: step === 'configure' || step === 'edit' ? undefined : 'none' }}>
      <Alert
        type="info"
        showIcon
        title="Save and verify before enabling"
        description="Discord gateways run on PostgreSQL. Save this channel disabled, apply the recommended application settings, test the connection, then enable it."
        style={{ marginBottom: 16 }}
      />
      <Form.Item
        label="Application ID"
        name="discord_application_id"
        rules={[
          { required: true, message: 'Application ID is required' },
          {
            validator: async (_rule, value) => {
              if (!isDiscordSnowflake(value)) throw new Error('Enter a Discord Snowflake');
            },
          },
        ]}
      >
        <Input placeholder="123456789012345678" inputMode="numeric" />
      </Form.Item>
      <Form.Item
        label="Server (Guild) ID"
        name="discord_guild_id"
        rules={[
          { required: true, message: 'Server ID is required' },
          {
            validator: async (_rule, value) => {
              if (!isDiscordSnowflake(value)) throw new Error('Enter a Discord Snowflake');
            },
          },
        ]}
      >
        <Input placeholder="223456789012345678" inputMode="numeric" />
      </Form.Item>
      <Form.Item
        label={
          <span>
            Bot token {mode === 'edit' && tokenStored ? <Tag color="green">Stored</Tag> : null}
          </span>
        }
        name="discord_bot_token"
        rules={[
          {
            validator: async (_rule, value) => {
              const candidate = typeof value === 'string' ? value.trim() : '';
              if ((mode === 'create' || !tokenStored) && !candidate) {
                throw new Error('Bot token is required');
              }
              if (candidate === GATEWAY_REDACTED_SENTINEL) {
                throw new Error('Enter the bot token copied from Discord');
              }
              if (
                candidate &&
                new TextEncoder().encode(candidate).byteLength > DISCORD_BOT_TOKEN_MAX_BYTES
              ) {
                throw new Error(`Bot token must be at most ${DISCORD_BOT_TOKEN_MAX_BYTES} bytes`);
              }
            },
          },
        ]}
        tooltip="Bot → Reset Token. The value is write-only; leave blank while editing to keep it."
      >
        <Input.Password
          placeholder={mode === 'edit' ? 'Leave blank to keep current' : 'Paste once'}
        />
      </Form.Item>
      <Form.Item
        label="Allowed parent channel IDs"
        name="discord_allowed_channel_ids"
        rules={[
          {
            validator: async (_rule, value) => validateDiscordAllowedParentIds(value),
          },
        ]}
        tooltip={`Up to ${DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES} parent text or forum channel Snowflakes. Empty never means all channels.`}
      >
        <Select
          mode="tags"
          tokenSeparators={[',', ' ']}
          placeholder="423456789012345678"
          maxCount={DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES}
        />
      </Form.Item>

      <Typography.Text strong>User alignment</Typography.Text>
      <Form.Item name="align_discord_users" initialValue={true} style={{ marginTop: 8 }}>
        <Radio.Group>
          <Space orientation="vertical">
            <Radio value={true}>Align Discord users</Radio>
            <Radio value={false}>Run as selected user</Radio>
          </Space>
        </Radio.Group>
      </Form.Item>
      {alignUsers ? (
        <Form.List
          name="discord_user_map"
          initialValue={[{ discordUserId: '', agorUserId: '' }]}
          rules={[
            {
              validator: async (_rule, value) =>
                validateDiscordUserMapRows(value, new Set(userById.keys())),
            },
          ]}
        >
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map((field, index) => (
                <Space key={field.key} align="start" style={{ display: 'flex', marginBottom: 8 }}>
                  <Form.Item
                    {...field}
                    name={[field.name, 'discordUserId']}
                    rules={[
                      { required: true, message: 'Discord User ID is required' },
                      {
                        validator: async (_rule, value) => {
                          if (!isDiscordSnowflake(value)) throw new Error('Invalid Snowflake');
                        },
                      },
                    ]}
                  >
                    <Input placeholder={`Discord User ID ${index + 1}`} inputMode="numeric" />
                  </Form.Item>
                  <Form.Item
                    {...field}
                    name={[field.name, 'agorUserId']}
                    rules={[{ required: true, message: 'Choose an Agor user' }]}
                    style={{ minWidth: 240 }}
                  >
                    <UserSelect userById={userById} />
                  </Form.Item>
                  <Button
                    type="text"
                    danger
                    aria-label={`Remove user mapping ${index + 1}`}
                    icon={<DeleteOutlined />}
                    onClick={() => remove(field.name)}
                  />
                </Space>
              ))}
              <Form.ErrorList errors={errors} />
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                disabled={mapRows.length >= DISCORD_USER_MAP_MAX_ENTRIES}
                onClick={() => add({ discordUserId: '', agorUserId: '' })}
                block
              >
                Add user mapping
              </Button>
            </>
          )}
        </Form.List>
      ) : (
        <>
          <Alert
            type="error"
            showIcon
            title="High-authority shared identity"
            description="Every accepted Discord mention will run as the selected Agor user and use that user's execution and credential context."
            style={{ marginBottom: 12 }}
          />
          <Form.Item
            label="Run as user"
            name="agor_user_id"
            rules={[{ required: true, message: 'Choose a Run as user' }]}
          >
            <UserSelect userById={userById} />
          </Form.Item>
        </>
      )}

      <Form.Item
        label="Ingest attached files"
        name="ingest_files"
        valuePropName="checked"
        initialValue={DISCORD_GATEWAY_FORM_DEFAULTS.ingest_files}
        tooltip="Opt in to safe current-summon image, text, and JSON attachment staging. PDFs and ambient history attachments are not downloaded."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Assistants can read mapped thread history"
        name="discord_thread_history"
        valuePropName="checked"
        initialValue={DISCORD_GATEWAY_FORM_DEFAULTS.discord_thread_history}
      >
        <Switch />
      </Form.Item>
      <Checkbox checked disabled>
        Every prompt requires an explicit mention; top-level mentions create public threads
      </Checkbox>
    </div>
  );

  const portal = (
    <div style={{ display: step === 'portal' || step === 'edit' ? undefined : 'none' }}>
      <Alert
        type="info"
        showIcon
        title="Create the application in Discord first"
        description="Discord has no manifest import or API for creating an application. Agor can apply only the documented editable current-application subset after this disabled channel is saved."
        style={{ marginBottom: 16 }}
      />
      <ol style={{ paddingLeft: 20 }}>
        <li>
          Open{' '}
          <Typography.Link
            href={DISCORD_DEVELOPER_APPLICATIONS_URL}
            target="_blank"
            rel="noreferrer"
          >
            Discord Developer Portal
          </Typography.Link>{' '}
          → <strong>Create Application</strong>.
        </li>
        <li>
          Open <strong>Bot</strong> → <strong>Reset Token</strong>, then copy the token once.
        </li>
        <li>
          Copy the <strong>Application ID</strong>. In Discord enable Developer Mode, then copy the
          Server ID and each allowed parent Channel ID.
        </li>
        <li>Save this Agor channel disabled.</li>
        <li>Apply the reviewed settings, install the bot, then test the connection.</li>
      </ol>
      <Typography.Text strong>Machine-derived reviewed settings</Typography.Text>
      <div style={{ margin: '8px 0' }}>
        {DISCORD_GATEWAY_INTENT_NAMES.map((name) => (
          <Tag key={name} color={name.includes('Message Content') ? 'orange' : undefined}>
            {name}
          </Tag>
        ))}
      </div>
      <div style={{ marginBottom: 8 }}>
        {DISCORD_LAUNCH_PERMISSION_NAMES.map((name) => (
          <Tag key={name}>{name}</Tag>
        ))}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Permission integer: <code>{DISCORD_LAUNCH_PERMISSIONS_DECIMAL}</code>. Administrator, Manage
        Threads, and Mention Everyone are not requested.
      </Typography.Text>
      <pre style={{ maxHeight: 220, overflow: 'auto', padding: 12, fontSize: 11 }}>{preview}</pre>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Gateway WSS and bot REST require no callback URL, redirect URL, public webhook, or
        Interactions endpoint.
      </Typography.Paragraph>

      {mode === 'edit' ? (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Button
            icon={<ThunderboltOutlined />}
            loading={applyLoading}
            disabled={channelEnabled || setupDirty}
            onClick={onApply}
          >
            Apply recommended app settings
          </Button>
          {applyResult && (
            <Alert
              type={applyResult.ok ? 'success' : 'warning'}
              showIcon
              title={
                applyResult.ok
                  ? 'Reviewed application settings applied'
                  : 'Application result is ambiguous — retest before continuing'
              }
            />
          )}
          {installUrl && (
            <Space>
              <Typography.Link href={installUrl} target="_blank" rel="noreferrer">
                Install bot in the configured server ↗
              </Typography.Link>
              <Button
                size="small"
                icon={copied ? <CheckCircleOutlined /> : <CopyOutlined />}
                onClick={async () => {
                  const ok = await copyText(installUrl);
                  setCopied(ok);
                }}
              >
                {copied ? 'Copied' : 'Copy install URL'}
              </Button>
            </Space>
          )}
          <Button loading={testLoading} disabled={channelEnabled || setupDirty} onClick={onTest}>
            Test connection
          </Button>
          {testResult && (
            <Alert
              type={testResult.ok ? 'success' : 'error'}
              showIcon
              title={testResult.ok ? 'Connection succeeded' : 'Connection failed'}
              description={
                testResult.failures.length > 0
                  ? testResult.failures.map((failure) => failure.reason).join(' ')
                  : 'The saved bot identity and reviewed launch settings were verified.'
              }
            />
          )}
          {channelEnabled && (
            <Alert
              type="warning"
              showIcon
              title="Disable and save before setup"
              description="Enabled channels cannot create a second setup REST client."
            />
          )}
          {setupDirty && !channelEnabled && (
            <Alert
              type="warning"
              showIcon
              title="Save changes before setup"
              description="Application settings and connection tests use the saved disabled configuration."
            />
          )}
        </Space>
      ) : (
        <Alert
          type="warning"
          showIcon
          title="Save before testing or applying settings"
          description="Discord setup operations require a persisted disabled PostgreSQL channel."
        />
      )}
    </div>
  );

  return (
    <>
      {configuration}
      {portal}
    </>
  );
};
