// biome-ignore-all lint/plugin/noHardcodedColorLiteral: exact color inputs and emitted alpha values are the helper contract
import { theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { glassCardStyle, glassSurfaceStyle, withAlpha } from './glassStyles';

describe('shared glass styles', () => {
  it('applies alpha to hex and rgb theme colors', () => {
    expect(withAlpha('#ffffff', 0.75)).toBe('rgba(255, 255, 255, 0.75)');
    expect(withAlpha('rgb(20, 30, 40)', 0.6)).toBe('rgba(20, 30, 40, 0.6)');
  });

  it('builds a static token-driven glass surface', () => {
    const token = theme.getDesignToken({ algorithm: theme.darkAlgorithm });
    const style = glassSurfaceStyle(token, 0.68);

    expect(style.background).toBe(withAlpha(token.colorBgContainer, 0.68));
    expect(style.backdropFilter).toBe('blur(20px) saturate(180%)');
    expect(style).not.toHaveProperty('animation');
  });

  it('adds a subtle highlight to glass cards', () => {
    const token = theme.getDesignToken();
    const style = glassCardStyle(token, 0.82);

    expect(style.background).toBe(withAlpha(token.colorBgContainer, 0.82));
    expect(style.boxShadow).toContain('inset 0 1px 0');
  });
});
