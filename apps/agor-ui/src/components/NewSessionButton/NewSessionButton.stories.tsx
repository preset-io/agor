import type { Meta, StoryObj } from '@storybook/react';
import { ConfigProvider, theme } from 'antd';
import { NewSessionButton } from './NewSessionButton';

const meta = {
  title: 'Components/NewSessionButton',
  component: NewSessionButton,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <div style={{ height: '100vh', position: 'relative', background: '#141414' }}>
          <Story />
        </div>
      </ConfigProvider>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof NewSessionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    onClick: () => console.log('Create new session clicked'),
  },
};

export const WithAction: Story = {
  args: {
    onClick: () => alert('Opening new session modal...'),
  },
};
