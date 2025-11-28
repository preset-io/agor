import type { Meta, StoryObj } from '@storybook/react';
import { BrandLogo } from './BrandLogo';

const meta = {
  title: 'Components/BrandLogo',
  component: BrandLogo,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    level: {
      control: 'select',
      options: [1, 2, 3, 4, 5],
      description: 'Typography level (1-5)',
    },
  },
} satisfies Meta<typeof BrandLogo>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default brand logo at level 3 (default size)
 */
export const Default: Story = {
  args: {
    level: 3,
  },
};

/**
 * Large brand logo (level 1) - great for hero sections
 */
export const Large: Story = {
  args: {
    level: 1,
  },
};

/**
 * Medium brand logo (level 2) - perfect for login pages
 */
export const Medium: Story = {
  args: {
    level: 2,
  },
};

/**
 * Small brand logo (level 4) - compact displays
 */
export const Small: Story = {
  args: {
    level: 4,
  },
};

/**
 * Extra small brand logo (level 5) - inline text
 */
export const ExtraSmall: Story = {
  args: {
    level: 5,
  },
};

/**
 * All sizes comparison
 */
export const AllSizes: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'flex-start' }}>
      <div>
        <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.6 }}>Level 1 (Large)</div>
        <BrandLogo level={1} />
      </div>
      <div>
        <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.6 }}>Level 2 (Medium)</div>
        <BrandLogo level={2} />
      </div>
      <div>
        <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.6 }}>Level 3 (Default)</div>
        <BrandLogo level={3} />
      </div>
      <div>
        <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.6 }}>Level 4 (Small)</div>
        <BrandLogo level={4} />
      </div>
      <div>
        <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.6 }}>Level 5 (Extra Small)</div>
        <BrandLogo level={5} />
      </div>
    </div>
  ),
};
