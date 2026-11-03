// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive ConfigProvider colors verify semantic tool states
import { CloseCircleOutlined } from '@ant-design/icons';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolBlock, ToolDisclosureHeader } from './ToolBlock';

afterEach(cleanup);

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

    // Inspect the owned inline tone: jsdom cannot resolve AntD's CSS-variable border shorthand.
    expect(statusIconWrapper.style.color).toBe('rgb(255, 170, 0)');
    expect(statusIconWrapper.style.color).not.toBe('rgb(255, 0, 0)');
  });
});

it('marks executing tool groups busy without a second shimmer', () => {
  const view = (executing: boolean) => (
    <ToolDisclosureHeader
      label="Running: Read"
      expanded={false}
      executing={executing}
      onClick={() => {}}
    />
  );
  const { container, rerender } = render(view(true));
  // The turn's working line owns the one shimmer.
  expect(container.querySelector('.ant-thought-chain-motion-blink')).toBeNull();
  expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  rerender(view(false));
  expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'false');
});
