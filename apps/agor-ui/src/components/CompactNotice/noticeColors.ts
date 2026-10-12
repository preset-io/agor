import type { GlobalToken } from 'antd';
import { pickAccessibleColor } from '../../utils/theme';

export type CompactNoticeType = 'error' | 'warning' | 'info' | 'neutral';

export interface NoticeColors {
  background: string;
  border: string;
  /** Message, icon, controls and focus ring; at least 4.5:1 on `background`. */
  text: string;
}

/** Semantic surface and the in-hue text token that stays AA-legible on it. */
export function noticeColors(token: GlobalToken, type: CompactNoticeType): NoticeColors {
  const [background, border, candidates] = {
    error: [
      token.colorErrorBg,
      token.colorErrorBorder,
      [token.colorErrorText, token.colorErrorTextHover, token.colorErrorTextActive],
    ],
    warning: [
      token.colorWarningBg,
      token.colorWarningBorder,
      [token.colorWarningText, token.colorWarningTextHover, token.colorWarningTextActive],
    ],
    info: [
      token.colorInfoBg,
      token.colorInfoBorder,
      [token.colorInfoText, token.colorInfoTextHover, token.colorInfoTextActive],
    ],
    neutral: [token.colorFillAlter, token.colorBorderSecondary, [token.colorTextSecondary]],
  }[type] as [string, string, string[]];
  return {
    background,
    border,
    text: pickAccessibleColor(candidates, background, token.colorBgContainer),
  };
}
