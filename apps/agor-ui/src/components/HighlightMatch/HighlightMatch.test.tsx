import { render, screen } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { HighlightMatch } from './HighlightMatch';

describe.each([
  ['light', theme.defaultAlgorithm],
  ['dark', theme.darkAlgorithm],
] as const)('HighlightMatch in the %s theme', (_name, algorithm) => {
  it('uses the semantic warning surface with normal readable text', () => {
    const token = theme.getDesignToken({ algorithm });
    render(
      <ConfigProvider theme={{ algorithm }}>
        <HighlightMatch text="find this value" query="this" />
      </ConfigProvider>
    );

    expect(screen.getByText('this')).toHaveStyle({
      backgroundColor: token.colorWarningBg,
      color: token.colorText,
    });
  });
});
