/**
 * ToolIcon Component
 *
 * Displays a tool/agent logo in a circle with black background
 */

import { theme } from 'antd';
import ccLogo from '../../assets/tools/cc.png';
import claudeCodeCliLogo from '../../assets/tools/claude-code-cli.png';
import codexLogo from '../../assets/tools/codex.png';
import copilotLogo from '../../assets/tools/copilot.png';
import geminiLogo from '../../assets/tools/gemini.png';
import opencodeLogo from '../../assets/tools/opencode.png';

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
  'claude-code-cli': claudeCodeCliLogo,
  codex: codexLogo,
  gemini: geminiLogo,
  opencode: opencodeLogo,
  copilot: copilotLogo,
};

// Tools whose logos are drawn on a transparent / light background and need
// a white plate rather than the default black to read well. The pixel-bot
// CLI mascot already has its own white outline — black would clip it.
const LIGHT_BG_TOOLS = new Set(['claude-code-cli']);

export const ToolIcon: React.FC<ToolIconProps> = ({ tool, size = 32, className = '' }) => {
  const { token } = useToken();
  const logoSrc = toolLogos[tool];
  const bg = LIGHT_BG_TOOLS.has(tool) ? '#fff' : '#000';

  // Fallback to emoji if no logo available
  const fallbackEmoji: Record<string, string> = {
    'claude-code': '🤖',
    codex: '💻',
    gemini: '💎',
    opencode: '🌐',
    copilot: '✈️',
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
          background: bg,
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
        background: bg,
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
