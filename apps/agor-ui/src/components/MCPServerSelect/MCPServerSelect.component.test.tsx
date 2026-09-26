import type { MCPServer } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Form } from 'antd';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPServerSelect, type MCPServerSelectProps } from './MCPServerSelect';

afterEach(cleanup);

const enabledId = '01900000-0000-7000-8000-000000000001';
const disabledId = '01900000-0000-7000-8000-000000000002';
const unavailableId = '01900000-0000-7000-8000-000000000003';
const servers = [
  { mcp_server_id: enabledId, name: 'Enabled', transport: 'http', enabled: true },
  { mcp_server_id: disabledId, name: 'Paused integration', transport: 'http', enabled: false },
] as MCPServer[];

function Picker(props: Partial<MCPServerSelectProps>) {
  const [value, setValue] = useState(props.value ?? []);
  return (
    <MCPServerSelect
      mcpServers={servers}
      {...props}
      value={value}
      onChange={(ids) => {
        setValue(ids);
        props.onChange?.(ids);
      }}
    />
  );
}

describe('MCPServerSelect native attachment controls', () => {
  it('offers enabled servers for new attachment, never disabled servers', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(screen.queryByText('Disabled · Paused integration (http)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Enabled (http)'));
    expect(onChange).toHaveBeenLastCalledWith([enabledId]);
  });

  it.each([enabledId, disabledId, unavailableId])(
    'removes %s by mouse and cannot reoffer disabled/missing servers',
    (id) => {
      const onChange = vi.fn();
      const { container } = render(<Picker value={[id]} onChange={onChange} />);
      const remove = container.querySelector('.ant-select-selection-item-remove');
      expect(remove).not.toBeNull();
      fireEvent.mouseDown(remove!);
      fireEvent.click(remove!);
      expect(onChange).toHaveBeenLastCalledWith([]);
      fireEvent.mouseDown(screen.getByRole('combobox'));
      expect(screen.getByText('Enabled (http)')).toBeInTheDocument();
      expect(screen.queryByText('Disabled · Paused integration (http)')).not.toBeInTheDocument();
      expect(screen.queryByText(/Unavailable MCP server/)).not.toBeInTheDocument();
    }
  );

  it.each([enabledId, disabledId, unavailableId])('removes %s with Backspace', (id) => {
    const onChange = vi.fn();
    render(<Picker value={[id]} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it.each(['field', 'form'] as const)(
    'does not mutate a read-only %s, including disabled and unavailable selections',
    (source) => {
      const onChange = vi.fn();
      const { container } = render(
        <Form disabled={source === 'form'}>
          <Picker
            value={[enabledId, disabledId, unavailableId]}
            disabled={source === 'field' ? true : undefined}
            onChange={onChange}
          />
        </Form>
      );
      expect(screen.getByRole('combobox')).toBeDisabled();
      expect(container.querySelector('.ant-select-selection-item-remove')).toBeNull();
      expect(container.querySelector('.ant-select-clear')).toBeNull();
      fireEvent.mouseDown(screen.getByRole('combobox'));
      // A native disabled input cannot receive focus or real keyboard events.
      screen.getByRole('combobox').focus();
      expect(screen.getByRole('combobox')).not.toHaveFocus();
      expect(onChange).not.toHaveBeenCalled();
    }
  );

  it.each([0, 1])('keeps synthetic overflow non-closable with maxTagCount=%s', (maxTagCount) => {
    const { container } = render(
      <Picker value={[disabledId, enabledId, unavailableId]} maxTagCount={maxTagCount} />
    );
    expect(container.querySelectorAll('.ant-select-selection-item-remove')).toHaveLength(
      maxTagCount
    );
    const overflow = screen
      .getByText(`+ ${3 - maxTagCount} ...`)
      .closest('.ant-select-selection-item');
    expect(overflow).not.toBeNull();
    expect(overflow?.querySelector('.ant-select-selection-item-remove')).toBeNull();
  });

  it('uses only the unavailable placeholder for an ID absent from authorized hydration', () => {
    render(<Picker mcpServers={[]} value={[unavailableId]} />);
    expect(screen.getByText(/Unavailable MCP server/)).toBeInTheDocument();
    expect(screen.queryByText('Enabled (http)')).not.toBeInTheDocument();
    expect(screen.queryByText('Disabled · Paused integration (http)')).not.toBeInTheDocument();
  });

  it.each(['onOpenChange', 'onDropdownVisibleChange'] as const)(
    'preserves the caller’s %s callback',
    (callback) => {
      const onOpen = vi.fn();
      render(<Picker {...{ [callback]: onOpen }} />);
      fireEvent.mouseDown(screen.getByRole('combobox'));
      expect(onOpen).toHaveBeenCalledWith(true);
    }
  );

  it('uses a viewport host by default and preserves explicit popup overrides', () => {
    const { container, unmount } = render(<Picker open />);
    expect(container.querySelector('.ant-select-dropdown')).toBeNull();
    expect(document.body.querySelector(':scope > .ant-select-dropdown')).not.toBeNull();
    unmount();
    render(
      <Picker
        open
        getPopupContainer={() => container}
        placement="topRight"
        popupAlign={{ offset: [0, 10] }}
        listHeight={80}
      />
    );
    expect(container.querySelector('.ant-select-dropdown')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.ant-select-dropdown')?.style.position).not.toBe(
      'fixed'
    );
  });
});
