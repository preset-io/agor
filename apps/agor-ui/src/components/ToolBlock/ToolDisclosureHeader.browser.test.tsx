import { cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ToolDisclosureHeader } from './ToolBlock';

afterEach(cleanup);

function Examples() {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      style={{
        padding: token.paddingSM,
        background: token.colorBgContainer,
        color: token.colorText,
        maxWidth: 600,
      }}
    >
      <ToolDisclosureHeader
        label="Tool calls"
        count={123456}
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      />
      {expanded && <div>Expanded tool content</div>}
      <ToolDisclosureHeader label="Tool calls" expanded={false} onClick={vi.fn()} />
      <ToolDisclosureHeader label="Reasoning" count={0} expanded={false} onClick={vi.fn()} />
      <ToolDisclosureHeader
        label="Loading tool activity…"
        count={42}
        loading
        expanded={false}
        onClick={vi.fn()}
      />
      <ToolDisclosureHeader
        label="Running: a_very_long_tool_name_that_must_not_overflow_the_conversation"
        count={12}
        executing
        expanded={false}
        onClick={vi.fn()}
      />
      <ToolDisclosureHeader label="Latest: Read" count={12} expanded={false} onClick={vi.fn()} />
    </div>
  );
}

it.each([false, true])(
  'renders compact numeric tags with bounded labels (dark=%s)',
  async (dark) => {
    const { container } = render(
      <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
        <Examples />
      </ConfigProvider>
    );
    const header = screen.getByRole('button', { name: '123456 tool calls' });
    const tag = header.querySelector<HTMLElement>('.ant-tag')!;
    const styles = getComputedStyle(tag);
    const headerStyle = getComputedStyle(header);
    const icon = header.querySelector<HTMLElement>('.ant-btn-icon')!;
    const label = screen.getAllByText('Tool calls')[0];
    expect(styles.fontSize).toBe(headerStyle.fontSize);
    expect(styles.fontSize).toBe('12px');
    expect(parseFloat(styles.lineHeight)).toBeCloseTo(20, 1);
    expect(styles.marginInlineEnd).toBe('0px');
    expect(styles.paddingInlineStart).toBe('4px');
    expect(styles.paddingInlineEnd).toBe('4px');
    expect(tag.getBoundingClientRect().left - icon.getBoundingClientRect().right).toBeCloseTo(
      parseFloat(headerStyle.columnGap),
      1
    );
    expect(label.getBoundingClientRect().left - tag.getBoundingClientRect().right).toBeCloseTo(
      parseFloat(headerStyle.columnGap),
      1
    );
    expect(tag.getBoundingClientRect().height).toBeLessThan(header.getBoundingClientRect().height);
    expect(header.querySelectorAll('.ant-tag')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Tool calls' }).querySelector('.ant-tag')).toBeNull();
    expect(screen.getByRole('button', { name: 'Loading tool activity…' })).toBeDisabled();
    expect(container.querySelector('.ant-thought-chain-motion-blink')).not.toBeNull();
    for (const button of container.querySelectorAll('button')) {
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    }
    await page.screenshot({
      path: `./.vitest/tool-count-${dark ? 'dark' : 'light'}-${window.innerWidth}-collapsed.png`,
    });
    header.focus();
    await userEvent.keyboard('{Enter}');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Expanded tool content')).toBeVisible();
    await page.screenshot({
      path: `./.vitest/tool-count-${dark ? 'dark' : 'light'}-${window.innerWidth}-expanded.png`,
    });
    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  }
);
