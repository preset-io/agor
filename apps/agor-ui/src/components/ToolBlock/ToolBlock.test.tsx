// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive ConfigProvider colors verify semantic tool states
import { CloseCircleOutlined } from '@ant-design/icons';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import {
  COMPACT_CONTENT_OFFSET,
  COMPACT_GUTTER_GAP,
  COMPACT_GUTTER_SIZE,
} from '../ConversationView/compactLayout';
import { ToolBlock, type ToolBlockProps } from './ToolBlock';

describe('ToolBlock', () => {
  it('renders failed tool-call status icons with the warning tone', () => {
    render(
      <ConfigProvider
        theme={{
          token: {
            colorError: 'rgb(255, 0, 0)',
            colorWarning: 'rgb(255, 170, 0)',
          },
        }}
      >
        <ToolBlock
          icon={<CloseCircleOutlined data-testid="tool-failure-icon" />}
          name="Bash"
          status="error"
        />
      </ConfigProvider>
    );

    const statusIconWrapper = screen.getByTestId('tool-failure-icon').parentElement as HTMLElement;

    expect(statusIconWrapper).toHaveStyle({ color: 'rgb(255, 170, 0)' });
    expect(statusIconWrapper).not.toHaveStyle({ color: 'rgb(255, 0, 0)' });
  });
});

describe('ToolBlock compact grid', () => {
  const renderRow = (props: Partial<ToolBlockProps> = {}) =>
    render(
      <ToolBlock icon={<CloseCircleOutlined data-testid="row-icon" />} name="Bash" {...props}>
        <span data-testid="row-body">output</span>
      </ToolBlock>
    );

  const bodyOf = () => screen.getByTestId('row-body').parentElement as HTMLElement;
  const iconCellOf = () => screen.getByTestId('row-icon').parentElement as HTMLElement;

  it('centers the icon in the shared gutter and starts the body at the content edge', () => {
    renderRow({ compact: true });

    expect(iconCellOf()).toHaveStyle({
      width: `${COMPACT_GUTTER_SIZE}px`,
      justifyContent: 'center',
    });
    expect(iconCellOf().parentElement).toHaveStyle({ gap: `${COMPACT_GUTTER_GAP}px` });

    fireEvent.click(iconCellOf().parentElement as HTMLElement);
    expect(bodyOf()).toHaveStyle({ paddingLeft: `${COMPACT_CONTENT_OFFSET}px` });
  });

  it('keeps a nested list of rows in the gutter instead of insetting it', () => {
    renderRow({ compact: true, nestedRows: true, expandedByDefault: true });

    expect(bodyOf()).toHaveStyle({ paddingLeft: '0px' });
  });

  it('leaves the detailed row on its own indent', () => {
    renderRow({ expandedByDefault: true });

    expect(iconCellOf()).not.toHaveStyle({ width: `${COMPACT_GUTTER_SIZE}px` });
    expect(bodyOf()).toHaveStyle({ paddingLeft: '16px' });
  });
});
