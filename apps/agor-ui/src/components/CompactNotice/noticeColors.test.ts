// biome-ignore-all lint/plugin/noHardcodedColorLiteral: a user-picked custom theme seed is the test input
import { type GlobalToken, theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { AGOR_THEME_TOKENS } from '../../contexts/ThemeContext';
import { contrastRatio } from '../../utils/theme';
import { type CompactNoticeType, noticeColors } from './noticeColors';

const THEMES = {
  dark: theme.getDesignToken({ algorithm: theme.darkAlgorithm, token: AGOR_THEME_TOKENS }),
  light: theme.getDesignToken({ algorithm: theme.defaultAlgorithm, token: AGOR_THEME_TOKENS }),
  // Custom themes always render dark; a user may pick a dim semantic base.
  custom: theme.getDesignToken({
    algorithm: theme.darkAlgorithm,
    token: { ...AGOR_THEME_TOKENS, colorError: '#8b1a1a', colorInfo: '#1d4f91' },
  }),
};
const TYPES: CompactNoticeType[] = ['error', 'warning', 'info', 'neutral'];

describe('noticeColors', () => {
  it.each(
    Object.entries(THEMES).flatMap(([name, token]) => TYPES.map((type) => [name, type, token]))
  )('%s %s text (message, Details, actions) reaches WCAG AA on its surface', (_, type, token) => {
    const { background, text } = noticeColors(token as GlobalToken, type as CompactNoticeType);
    // Text is AA 4.5:1; the icon and focus ring reuse it, so they clear the 3:1 non-text bar too.
    expect(
      contrastRatio(text, background, (token as GlobalToken).colorBgContainer)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the semantic token when it already passes', () => {
    expect(noticeColors(THEMES.dark, 'warning').text).toBe(THEMES.dark.colorWarningText);
    expect(noticeColors(THEMES.dark, 'neutral').text).toBe(THEMES.dark.colorTextSecondary);
  });
});
