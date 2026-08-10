import { RobotOutlined } from '@ant-design/icons';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tag } from './Tag';

const LONG_LABEL = 'kimi-for-coding/kimi-for-coding-highspeed';

describe('Tag', () => {
  it('renders the outlined variant by default', () => {
    render(<Tag data-testid="tag">plain</Tag>);
    expect(screen.getByTestId('tag').className).toContain('outlined');
  });

  it('clips the label, not the tag, so a long value stays inside the border', () => {
    render(
      <Tag icon={<RobotOutlined />} truncate data-testid="tag">
        {LONG_LABEL}
      </Tag>
    );
    const root = screen.getByTestId('tag');
    // The tag itself must stay unclipped — `overflow: hidden` here would eat
    // antd's click ripple; `minWidth: 0` is what lets it shrink instead.
    expect(root.style.overflow).toBe('');
    expect(root.style.maxWidth).toBe('100%');
    expect(root.style.minWidth).toBe('0');
    const label = screen.getByText(LONG_LABEL);
    expect(label).not.toBe(root);
    expect(label.style.minWidth).toBe('0');
    expect(label.style.overflow).toBe('hidden');
    expect(label.style.textOverflow).toBe('ellipsis');
  });

  it('gives an icon-less tag its own label box to clip', () => {
    render(
      <Tag truncate data-testid="tag">
        {LONG_LABEL}
      </Tag>
    );
    // antd renders bare children when there is no icon, and a flex root makes
    // ellipsis on the root inert — so truncate has to supply the label box.
    const label = screen.getByText(LONG_LABEL);
    expect(label).not.toBe(screen.getByTestId('tag'));
    expect(label.style.overflow).toBe('hidden');
    expect(label.style.textOverflow).toBe('ellipsis');
  });

  it('keeps truncating when the caller also styles another part', () => {
    render(
      <Tag icon={<RobotOutlined />} truncate styles={{ icon: { fontSize: 20 } }}>
        {LONG_LABEL}
      </Tag>
    );
    expect(screen.getByText(LONG_LABEL).style.textOverflow).toBe('ellipsis');
    expect(screen.getByRole('img', { name: 'robot' }).style.fontSize).toBe('20px');
  });

  it('leaves layout untouched without truncate', () => {
    render(
      <Tag icon={<RobotOutlined />} data-testid="tag">
        {LONG_LABEL}
      </Tag>
    );
    expect(screen.getByTestId('tag').style.maxWidth).toBe('');
    expect(screen.getByText(LONG_LABEL).style.textOverflow).toBe('');
  });

  it('lets a caller style override the truncation defaults', () => {
    render(
      <Tag icon={<RobotOutlined />} truncate style={{ maxWidth: 120 }} data-testid="tag">
        {LONG_LABEL}
      </Tag>
    );
    const root = screen.getByTestId('tag');
    expect(root.style.maxWidth).toBe('120px');
    expect(root.style.display).toBe('inline-flex');
    expect(screen.getByText(LONG_LABEL).style.textOverflow).toBe('ellipsis');
  });
});
