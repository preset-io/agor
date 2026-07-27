import { render } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { brandMarkHref } from '../../branding/brand';
import { BrandMark } from './BrandMark';

describe.each([
  ['light', theme.defaultAlgorithm],
  ['dark', theme.darkAlgorithm],
] as const)('BrandMark in the %s theme', (_name, algorithm) => {
  it('colors the canonical SVG mask with the resolved primary token', () => {
    const token = theme.getDesignToken({ algorithm });
    const { container } = render(
      <ConfigProvider theme={{ algorithm }}>
        <BrandMark size={50} />
      </ConfigProvider>
    );

    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.firstChild).toHaveStyle({
      width: '50px',
      height: '50px',
      backgroundColor: token.colorPrimary,
      maskImage: `url("${brandMarkHref()}")`,
    });
  });
});
