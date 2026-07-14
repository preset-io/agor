import { DiscordIcon } from 'nextra/icons';
import { Footer, Navbar } from 'nextra-theme-docs';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import { getBasePath, LOGO_MARK_PATH } from '../lib/siteMetadata';

const basePath = getBasePath();

export const logo = (
  <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
    {/* alt="": decorative — the adjacent wordmark text names the link, and a
        non-empty alt would be flagged as redundant by screen readers/axe. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
    <img
      src={`${basePath}${LOGO_MARK_PATH}`}
      alt=""
      style={{ height: '42px', width: '42px' }}
      suppressHydrationWarning
    />
    <strong
      style={{
        fontSize: '18px',
        background: 'linear-gradient(90deg, #2e9a92 0%, #7fe8df 50%, #a8f5ed 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
      }}
    >
      agor
    </strong>
  </span>
);

export const navbar = (
  <Navbar
    logo={logo}
    projectLink={GITHUB_REPO_URL}
    chatLink={DISCORD_INVITE_URL}
    // Default chat icon ships without an accessible name (axe: link-name);
    // role="img" + aria-label makes the icon-only link announce as "Discord".
    chatIcon={<DiscordIcon width="24" role="img" aria-label="Discord" />}
  />
);

export const footer = <Footer>BSL 1.1 © {new Date().getFullYear()} Preset Inc.</Footer>;

export const sharedLayoutProps = {
  docsRepositoryBase: 'https://github.com/preset-io/agor/tree/main/apps/agor-docs',
  navigation: { prev: true, next: true },
  sidebar: { defaultMenuCollapseLevel: 1, toggleButton: true },
  toc: { backToTop: true },
  editLink: <>Edit this page on GitHub →</>,
  feedback: { content: 'Question? Give us feedback →', labels: 'feedback' },
  nextThemes: { defaultTheme: 'dark' },
};
