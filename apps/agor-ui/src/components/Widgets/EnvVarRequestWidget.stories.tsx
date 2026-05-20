import type { Message, WidgetMessageMetadata } from '@agor-live/client';
import type { Meta, StoryObj } from '@storybook/react';
import { ConfigProvider, theme } from 'antd';
import { EnvVarRequestWidget } from './EnvVarRequestWidget';

function makeMessage(widget: WidgetMessageMetadata): Message {
  return {
    message_id: widget.widget_id,
    session_id: 'sess-storybook' as never,
    type: 'widget_request',
    role: 'system',
    index: 0,
    timestamp: '2026-05-19T12:00:00.000Z',
    content: 'Please provide env vars',
    content_preview: 'Please provide env vars',
    metadata: { widget },
  } as unknown as Message;
}

function makeWidget(
  overrides: Partial<WidgetMessageMetadata> & { params?: Record<string, unknown> }
): WidgetMessageMetadata {
  const { params: paramOverrides, ...rest } = overrides;
  return {
    widget_id: 'wid-storybook-1' as never,
    widget_type: 'env_vars',
    schema_version: 1,
    status: 'pending',
    requested_at: '2026-05-19T12:00:00.000Z',
    auto_resume: true,
    params: {
      names: ['HUBSPOT_API_KEY'],
      reason: 'Needed to call the Hubspot API.',
      default_scope: 'global',
      ...(paramOverrides ?? {}),
    },
    ...rest,
  } as WidgetMessageMetadata;
}

const meta = {
  title: 'Widgets/EnvVarRequestWidget',
  component: EnvVarRequestWidget,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <div style={{ width: 560, padding: 24, background: '#141414' }}>
          <Story />
        </div>
      </ConfigProvider>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof EnvVarRequestWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PendingSingle: Story = {
  args: {
    message: makeMessage(makeWidget({})),
    widget: makeWidget({}),
  },
};

export const PendingMultiple: Story = {
  args: (() => {
    const widget = makeWidget({
      params: {
        names: ['HUBSPOT_API_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY'],
        reason: 'Needed to fan out to three downstream APIs in this task.',
        default_scope: 'global',
      },
    });
    return { message: makeMessage(widget), widget };
  })(),
};

export const PendingNoReason: Story = {
  args: (() => {
    const widget = makeWidget({
      params: {
        names: ['HUBSPOT_API_KEY'],
        reason: '',
        default_scope: 'global',
      },
    });
    return { message: makeMessage(widget), widget };
  })(),
};

export const Submitted: Story = {
  args: (() => {
    const widget = makeWidget({
      status: 'submitted',
      resolved_at: '2026-05-19T12:34:56.000Z',
      submitted_by: 'user-1' as never,
      result_meta: { names_submitted: ['HUBSPOT_API_KEY'], scope: 'global' },
    });
    return { message: makeMessage(widget), widget };
  })(),
};

export const Dismissed: Story = {
  args: (() => {
    const widget = makeWidget({
      status: 'dismissed',
      resolved_at: '2026-05-19T12:34:56.000Z',
    });
    return { message: makeMessage(widget), widget };
  })(),
};

export const AlreadyPresent: Story = {
  args: (() => {
    const widget = makeWidget({
      status: 'already_present',
      resolved_at: '2026-05-19T12:00:00.001Z',
    });
    return { message: makeMessage(widget), widget };
  })(),
};
