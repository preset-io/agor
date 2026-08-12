/**
 * McpLogo — renders an official brand mark for an MCP integration.
 *
 * Brand marks are the monochrome CC0 silhouettes from simple-icons, tinted via
 * CSS mask so they stay legible on any surface. Falls back to a neutral AntD
 * icon when a brand asset is not bundled (e.g. Amplitude).
 */

import { ApiOutlined } from '@ant-design/icons';
import { theme } from 'antd';
import datadogLogo from '../../assets/mcp/datadog.svg';
import figmaLogo from '../../assets/mcp/figma.svg';
import githubLogo from '../../assets/mcp/github.svg';
import hubspotLogo from '../../assets/mcp/hubspot.svg';
import linearLogo from '../../assets/mcp/linear.svg';
import notionLogo from '../../assets/mcp/notion.svg';
import sentryLogo from '../../assets/mcp/sentry.svg';
import slackLogo from '../../assets/mcp/slack.svg';
import stripeLogo from '../../assets/mcp/stripe.svg';

const mcpLogos: Record<string, string> = {
  slack: slackLogo,
  github: githubLogo,
  sentry: sentryLogo,
  datadog: datadogLogo,
  hubspot: hubspotLogo,
  figma: figmaLogo,
  linear: linearLogo,
  stripe: stripeLogo,
  notion: notionLogo,
};

export interface McpLogoProps {
  /** MCP recommendation id (e.g. "slack", "github") */
  id: string;
  /** Brand name for the accessible label */
  name?: string;
  /** Size in pixels (default: 20) */
  size?: number;
  /** Tint color; defaults to the secondary text token */
  color?: string;
}

export const McpLogo: React.FC<McpLogoProps> = ({ id, name, size = 20, color }) => {
  const { token } = theme.useToken();
  const tint = color ?? token.colorTextSecondary;
  const label = name ? `${name} logo` : 'MCP logo';
  const src = mcpLogos[id];

  if (!src) {
    return (
      <ApiOutlined aria-label={label} style={{ fontSize: size, color: tint, flexShrink: 0 }} />
    );
  }

  return (
    <span
      role="img"
      aria-label={label}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flexShrink: 0,
        backgroundColor: tint,
        maskImage: `url(${src})`,
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskImage: `url(${src})`,
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskSize: 'contain',
      }}
    />
  );
};
