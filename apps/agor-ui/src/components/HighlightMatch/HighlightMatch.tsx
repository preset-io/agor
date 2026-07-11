import { theme } from 'antd';
import type React from 'react';
import { getHighlightTerms } from '../../utils/highlightTerms';

interface HighlightMatchProps {
  text: string;
  query?: string;
  terms?: string[];
  minTermLength?: number;
}

export const HighlightMatch: React.FC<HighlightMatchProps> = ({
  text,
  query = '',
  terms,
  minTermLength = 2,
}) => {
  const { token } = theme.useToken();
  const highlightTerms = terms ?? getHighlightTerms(query, minTermLength);

  if (!text || highlightTerms.length === 0) return <>{text}</>;

  const escapedTerms = highlightTerms.map(escapeRegExp).filter(Boolean);
  if (escapedTerms.length === 0) return <>{text}</>;

  const matcher = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  const parts = text.split(matcher);

  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;
        const isMatch = highlightTerms.some((term) => term.toLowerCase() === part.toLowerCase());

        return isMatch ? (
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces from a stable string split
            key={index}
            style={{
              backgroundColor: token.colorWarningBg,
              color: token.colorText,
            }}
          >
            {part}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces from a stable string split
          <span key={index}>{part}</span>
        );
      })}
    </>
  );
};

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
