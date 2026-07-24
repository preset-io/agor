import { render } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { BrandLogo } from './BrandLogo';

describe.each([
  ['light', theme.defaultAlgorithm],
  ['dark', theme.darkAlgorithm],
] as const)('BrandLogo in the %s theme', (_name, algorithm) => {
  it('uses the resolved semantic primary ramp without a pale fixed endpoint', () => {
    const token = theme.getDesignToken({ algorithm });
    const { getByRole } = render(
      <ConfigProvider theme={{ algorithm }}>
        <BrandLogo />
      </ConfigProvider>
    );

    expect(getByRole('heading', { name: 'agor' })).toHaveStyle({
      background: `linear-gradient(90deg, ${token.colorPrimaryActive} 0%, ${token.colorPrimary} 52%, ${token.colorPrimaryHover} 100%)`,
    });
  });
});
