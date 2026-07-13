import { Footer, Navbar } from 'nextra-theme-docs';
import { NavbarCloudCTA } from '../components/NavbarCloudCTA';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import { BRAND_NAME, getBasePath, LOGO_PATH } from '../lib/siteMetadata';

const basePath = getBasePath();

export const logo = (
  <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
    <img
      src={`${basePath}${LOGO_PATH}`}
      alt={BRAND_NAME}
      style={{ height: '42px', width: '42px', borderRadius: '50%' }}
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
  <Navbar logo={logo} projectLink={GITHUB_REPO_URL} chatLink={DISCORD_INVITE_URL}>
    <NavbarCloudCTA />
  </Navbar>
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
