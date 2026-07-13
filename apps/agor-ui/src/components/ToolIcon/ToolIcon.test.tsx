import { render, screen } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { ToolIcon } from './ToolIcon';

const renderInDarkTheme = (tool: string) =>
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <ToolIcon tool={tool} />
    </ConfigProvider>
  );

describe('ToolIcon image plates', () => {
  it('keeps transparent agent-tool logos on their exact black plate in dark mode', () => {
    renderInDarkTheme('codex');

    expect(screen.getByAltText('codex logo').parentElement).toHaveStyle({
      // biome-ignore lint/plugin/noHardcodedColorLiteral: regression fixture asserts the exact brand-asset plate
      background: '#000000',
    });
  });

  it('keeps the white-outlined CLI mascot on its exact black plate in dark mode', () => {
    renderInDarkTheme('claude-code-cli');

    expect(screen.getByAltText('claude-code-cli logo').parentElement).toHaveStyle({
      // biome-ignore lint/plugin/noHardcodedColorLiteral: regression fixture asserts the exact brand-asset plate
      background: '#000000',
    });
  });
});
