// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive ConfigProvider colors verify semantic tool states
import { CloseCircleOutlined } from '@ant-design/icons';
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import { ToolBlock } from './ToolBlock';

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
