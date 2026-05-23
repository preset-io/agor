import type { Meta, StoryObj } from '@storybook/react';
import { ConfigProvider, theme } from 'antd';
import { AppHeader } from './AppHeader';

const meta = {
  title: 'Components/AppHeader',
  component: AppHeader,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <Story />
      </ConfigProvider>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof AppHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

const EMPTY_DATA_MAPS = {
  sessionById: new Map(),
  worktreeById: new Map(),
  boardById: new Map(),
  artifactById: new Map(),
  mcpServerById: new Map(),
};

export const Default: Story = {
  args: {
    ...EMPTY_DATA_MAPS,
    onMenuClick: () => console.log('Menu clicked'),
    onSettingsClick: () => console.log('Settings clicked'),
  },
};

export const WithActions: Story = {
  args: {
    ...EMPTY_DATA_MAPS,
    onMenuClick: () => alert('Menu clicked'),
    onSettingsClick: () => alert('Settings clicked'),
  },
};
