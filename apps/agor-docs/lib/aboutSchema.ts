/**
 * /about: the visible "Agor FAQ" and the page's JSON-LD (AboutPage + FAQPage).
 *
 * The FAQ answers are rendered on the page from ABOUT_FAQ and serialized into
 * the FAQPage block from the same array, so the structured data always matches
 * the visible copy word for word (Google requires FAQ schema to mirror visible
 * content). Copy is from the approved about-page spec; change it there first.
 *
 * Bump ABOUT_DATE_MODIFIED whenever the page copy changes.
 */
import { getSiteUrl } from './siteMetadata';

export const ABOUT_DATE_MODIFIED = '2026-11-20';

export const ABOUT_DESCRIPTION =
  'Agor is multiplayer AI: teams and agents on live spatial boards. Created by Preset and Maxime Beauchemin, original creator of Apache Airflow and Superset.';

export const ABOUT_FAQ: ReadonlyArray<{ question: string; answer: string }> = [
  {
    question: 'What is Agor?',
    answer:
      "Agor is a multiplayer AI platform where teams and AI agents work together on live spatial boards. Agents run in isolated git worktrees, and long-lived AI teammates have a role, memory, and connections to a team's tools and knowledge.",
  },
  {
    question: 'Who created Agor?',
    answer:
      "Agor is created and maintained by Preset, Inc. Maxime Beauchemin, Preset's founder and CEO and the original creator of Apache Airflow and Apache Superset, started it in fall 2025.",
  },
  {
    question: 'Is Agor open source?',
    answer:
      'Agor is source-available under the Business Source License (BSL) 1.1, not open source. The code is public on GitHub and you can self-host it.',
  },
  {
    question: 'What is Agor Cloud?',
    answer:
      'Agor Cloud is the hosted version of Agor, run by Preset. It entered open beta on October 13, 2026. Because it is a beta, use it for non-critical work and keep your own backups.',
  },
  {
    question: 'How does Agor relate to Preset and Apache Superset?',
    answer:
      "Preset is an open analytics platform powered by Apache Superset. Agor is a separate product with a different job: a shared place for teams and agents to do research, engineering, and operations work. An agent working in Agor can reach Preset's analytics through MCP.",
  },
  {
    question: 'Which AI agents does Agor work with?',
    answer:
      'Agor works with agent harnesses including Claude Code, Codex, and Gemini. You bring your own API keys or supported subscriptions and choose the agent and model that fit each task.',
  },
];

const siteUrl = getSiteUrl();
const pageUrl = `${siteUrl}/about`;

/**
 * AboutPage and Person (Maxime Beauchemin) entities, reusing the site-wide
 * graph ids from app/layout.tsx.
 */
export const ABOUT_PAGE_SCHEMA = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'AboutPage',
      '@id': `${pageUrl}#webpage`,
      url: pageUrl,
      name: 'About Agor',
      description: ABOUT_DESCRIPTION,
      isPartOf: { '@id': `${siteUrl}/#website` },
      about: { '@id': `${siteUrl}/#software` },
      publisher: { '@id': `${siteUrl}/#organization` },
      dateModified: ABOUT_DATE_MODIFIED,
    },
    {
      '@type': 'Person',
      '@id': `${pageUrl}#maxime-beauchemin`,
      name: 'Maxime Beauchemin',
      jobTitle: 'Founder and CEO',
      worksFor: { '@id': `${siteUrl}/#organization` },
      sameAs: ['https://www.linkedin.com/in/maximebeauchemin/'],
    },
  ],
};

export const ABOUT_FAQ_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  '@id': `${pageUrl}#faq`,
  isPartOf: { '@id': `${pageUrl}#webpage` },
  mainEntity: ABOUT_FAQ.map(({ question, answer }) => ({
    '@type': 'Question',
    name: question,
    acceptedAnswer: { '@type': 'Answer', text: answer },
  })),
};
