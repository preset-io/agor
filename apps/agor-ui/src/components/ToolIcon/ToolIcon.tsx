/**
 * ToolIcon Component
 *
 * Displays a tool/agent logo in a circle with black background
 */

import { theme } from 'antd';
import ccLogo from '../../assets/tools/cc.png';
import codexLogo from '../../assets/tools/codex.png';
import geminiLogo from '../../assets/tools/gemini.png';

const { useToken } = theme;

export interface ToolIconProps {
  /** Tool/agent name (e.g., "claude-code", "codex", "gemini") */
  tool: string;
  /** Size in pixels (default: 32) */
  size?: number;
  /** Additional CSS class */
  className?: string;
}

const toolLogos: Record<string, string> = {
  'claude-code': ccLogo,
  codex: codexLogo,
  gemini: geminiLogo,
};

export const ToolIcon: React.FC<ToolIconProps> = ({ tool, size = 32, className = '' }) => {
  const { token } = useToken();
  const logoSrc = toolLogos[tool];

  // Fallback to emoji if no logo available
  const fallbackEmoji: Record<string, string> = {
    'claude-code': '🤖',
    codex: '💻',
    gemini: '💎',
  };

  if (!logoSrc) {
    // Render emoji fallback
    return (
      <div
        className={`tool-icon ${className}`}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: '#000',
          border: `1px solid ${token.colorBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size * 0.6,
          flexShrink: 0,
        }}
      >
        {fallbackEmoji[tool] || '🤖'}
      </div>
    );
  }

  return (
    <div
      className={`tool-icon ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#000',
        border: `1px solid ${token.colorBorder}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: size * 0.1,
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <img
        src={logoSrc}
        alt={`${tool} logo`}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
        }}
      />
    </div>
  );
};
