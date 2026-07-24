// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive ConfigProvider colors verify gradient token propagation
import { render } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { GradientBackdrop, getGradientBackgroundImage } from './GradientBackdrop';

describe.each([
  ['light', theme.defaultAlgorithm],
  ['dark', theme.darkAlgorithm],
] as const)('GradientBackdrop in the %s theme', (_name, algorithm) => {
  it('uses the resolved theme surface while remaining decorative and inert', () => {
    const token = theme.getDesignToken({ algorithm });
    const { container } = render(
      <ConfigProvider theme={{ algorithm }}>
        <GradientBackdrop />
      </ConfigProvider>
    );

    const backdrop = container.querySelector('[data-gradient-backdrop="page"]');
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    expect(backdrop).toHaveStyle({
      backgroundColor: token.colorBgLayout,
      pointerEvents: 'none',
    });
    expect(container.querySelector('canvas')).not.toBeInTheDocument();
    expect(backdrop?.getAttribute('style')).not.toContain('animation');
  });
});

it('builds the ambient glows from custom semantic theme colors', () => {
  const background = getGradientBackgroundImage(
    {
      colorPrimary: 'rgb(1, 20, 30)',
      colorPrimaryHover: 'rgb(2, 40, 60)',
      colorInfo: 'rgb(3, 60, 90)',
    },
    'panel'
  );

  expect(background).toContain('rgb(1, 20, 30) 14%');
  expect(background).toContain('rgb(2, 40, 60) 10%');
  expect(background).toContain('rgb(3, 60, 90) 7%');
});
