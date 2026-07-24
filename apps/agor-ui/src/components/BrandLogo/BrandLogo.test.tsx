import { render } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { BrandLogo } from './BrandLogo';

describe.each([
  ['light', theme.defaultAlgorithm],
  ['dark', theme.darkAlgorithm],
] as const)('BrandLogo in the %s theme', (_name, algorithm) => {
  it('moves along the primary hue toward theme-appropriate contrast', () => {
    const token = theme.getDesignToken({ algorithm });
    const dark = _name === 'dark';
    const midpoint = `oklch(from ${token.colorPrimary} calc(l ${dark ? '+ 0.18' : '- 0.10'}) c h)`;
    const endpoint = `oklch(from ${token.colorPrimary} calc(l ${dark ? '+ 0.30' : '- 0.18'}) c h)`;
    const { getByRole } = render(
      <ConfigProvider theme={{ algorithm }}>
        <BrandLogo />
      </ConfigProvider>
    );

    expect(getByRole('heading', { name: 'agor' })).toHaveStyle({
      backgroundImage: `linear-gradient(90deg, ${token.colorPrimary} 0%, ${midpoint} 50%, ${endpoint} 100%)`,
      backgroundClip: 'text',
    });
  });
});
