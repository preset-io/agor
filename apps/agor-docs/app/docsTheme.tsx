import { Footer } from 'nextra-theme-docs';
import { FinePrint } from '../components/FinePrint';
import { FooterLegal } from '../components/FooterLegal';
import { IslandNav } from '../components/nav/IslandNav';

// The floating-island global nav replaces Nextra's navbar site-wide; it owns
// search (⌘K palette over the nav IA plus Pagefind) and the mobile menu.
// Keyed: Nextra places it in a children array, and a client element created
// in this server module otherwise trips React's missing-key warning.
export const navbar = <IslandNav key="island-nav" />;

export const footer = (
  <Footer>
    <span>
      <FinePrint />
      <FooterLegal className="agor-docs-footer-legal" />
    </span>
  </Footer>
);

export const sharedLayoutProps = {
  docsRepositoryBase: 'https://github.com/preset-io/agor/tree/main/apps/agor-docs',
  navigation: { prev: true, next: true },
  sidebar: { defaultMenuCollapseLevel: 1, toggleButton: true },
  toc: { backToTop: true },
  editLink: <>Edit this page on GitHub</>,
  feedback: { content: 'Question? Give us feedback', labels: 'feedback' },
  nextThemes: { defaultTheme: 'dark' },
};
