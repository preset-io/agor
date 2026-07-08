import { CloseCircleOutlined } from '@ant-design/icons';
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import { ToolBlock } from './ToolBlock';
import { deriveToolStatus } from './toolStatus';

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

describe('deriveToolStatus', () => {
  it('keeps missing-result tools pending while the parent task is still running', () => {
    expect(
      deriveToolStatus({
        hasResult: false,
        isPotentiallyRunning: false,
        isTaskRunning: true,
      })
    ).toBe('pending');
  });

  it('marks missing-result tools stale only after the parent task stops', () => {
    expect(
      deriveToolStatus({
        hasResult: false,
        isPotentiallyRunning: true,
        isTaskRunning: false,
      })
    ).toBe('stale');
  });
});
