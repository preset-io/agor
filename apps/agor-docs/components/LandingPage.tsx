import Link from 'next/link';
import { useState } from 'react';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import { BRAND_NAME, LOGO_PATH } from '../lib/siteMetadata';
import { HubSpotFormModal } from './HubSpotFormModal';
import styles from './LandingPage.module.css';

const assistants = ['ReviewBot', 'LaunchOps', 'Scout', 'Standup', 'Docs'];

const problemCards = [
  {
    title: 'Your agents are everywhere',
    body: 'More models, more tabs, more terminals. Keeping the work straight becomes its own job.',
  },
  {
    title: 'Learning stays private',
    body: 'Great prompts and workflows disappear behind individual screens instead of compounding for the team.',
  },
  {
    title: 'Useful bots live on laptops',
    body: 'PR reviewers, legal helpers, and report writers need ownership, memory, schedules, and visibility.',
  },
];

const featureCards = [
  {
    eyebrow: '01',
    title: 'Raise assistants together',
    body: 'Give each assistant a purpose, memory, skills, and access to the systems your team already uses.',
  },
  {
    eyebrow: '02',
    title: 'Work on a shared canvas',
    body: 'See teammates, branches, live environments, prompts, sessions, and progress in one multiplayer space.',
  },
  {
    eyebrow: '03',
    title: 'Let work happen on schedule',
    body: 'Run audits, standups, grooming, digests, reviews, and reports without waiting for someone to ask.',
  },
  {
    eyebrow: '04',
    title: 'Keep the receipts',
    body: 'Every prompt, tool call, decision, cost, and handoff stays observable and attached to the work.',
  },
];

const useCases = [
  'multi-agent code review',
  'release audits',
  'backlog grooming',
  'security sweeps',
  'competitive intel',
  'customer digests',
  'weekly reports',
  'standups',
];

const trustItems = [
  'Self-hosted first',
  'MCP-native',
  'Claude Code · Codex · Gemini',
  'Unix-level isolation when you need it',
];

function ProductMockup() {
  return (
    <div className={styles.mockup} role="img" aria-label="Agor product preview">
      <div className={styles.mockupTopbar}>
        <span />
        <span />
        <span />
      </div>
      <div className={styles.boardGrid}>
        <div className={`${styles.zone} ${styles.zoneA}`}>
          <span>Review lane</span>
          <div className={styles.branchCard}>
            <strong>security-audit</strong>
            <small>3 assistants running</small>
          </div>
        </div>
        <div className={`${styles.zone} ${styles.zoneB}`}>
          <span>Launch</span>
          <div className={styles.branchCard}>
            <strong>docs-refresh</strong>
            <small>ready for PR</small>
          </div>
        </div>
        <div className={`${styles.zone} ${styles.zoneC}`}>
          <span>Research</span>
          <div className={styles.branchCard}>
            <strong>pricing-intel</strong>
            <small>scheduled daily</small>
          </div>
        </div>
      </div>
      <div className={styles.agentBubble}>
        <div className={styles.avatarStack}>
          <span>R</span>
          <span>L</span>
          <span>S</span>
        </div>
        <p>
          <strong>Scout</strong> found 6 changes, opened a follow-up, and posted the report.
        </p>
      </div>
      <div className={styles.commandCard}>
        <span className={styles.statusDot} />
        <span>Schedule · every weekday at 9:00</span>
      </div>
    </div>
  );
}

export function LandingPage() {
  const [isContactOpen, setIsContactOpen] = useState(false);

  return (
    <div className={styles.landingShell}>
      <section className={styles.heroSection}>
        <div className={styles.navAnnouncement}>
          Shared canvas for assistants, schedules, and live work
        </div>
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <div className={styles.brandMark}>
              {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
              <img src={LOGO_PATH} alt={`${BRAND_NAME} logo`} />
              <span>agor</span>
            </div>
            <p className={styles.kicker}>Team command center for all things agentic.</p>
            <h1>Meet your team of AI assistants.</h1>
            <p className={styles.heroDescription}>
              Everyone’s cranking with AI, but it’s chaos: scattered sessions, ephemeral context,
              nothing that compounds. Agor is where your team raises real assistants, wires them
              into the systems you live in, and watches the work happen in one shared place.
            </p>
            <div className={styles.heroActions}>
              <Link href="/guide" className={styles.primaryButton}>
                Start with the guide
              </Link>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setIsContactOpen(true)}
              >
                Contact us
              </button>
              <Link
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.textButton}
              >
                View GitHub →
              </Link>
            </div>
          </div>
          <ProductMockup />
        </div>
      </section>

      <section className={styles.assistantStrip} aria-label="Example assistants">
        <span>Assistants your team can actually share</span>
        <div>
          {assistants.map((assistant) => (
            <strong key={assistant}>@{assistant}</strong>
          ))}
        </div>
      </section>

      <section className={styles.problemSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Why teams need a home for AI work</span>
          <h2>One agent in a terminal is fine. Five across a team is chaos.</h2>
        </div>
        <div className={styles.problemGrid}>
          {problemCards.map((card) => (
            <article className={styles.problemCard} key={card.title}>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.workspaceSection}>
        <div className={styles.workspaceCopy}>
          <span className={styles.eyebrow}>The shared workspace</span>
          <h2>Build assistants that stick around.</h2>
          <p>
            Agor gives your team one place to launch assistants, teach them the workflows that
            matter, coordinate live work, and turn the patterns that work into shared muscle.
          </p>
        </div>
        <div className={styles.featureGrid}>
          {featureCards.map((feature) => (
            <article className={styles.featureCard} key={feature.title}>
              <span>{feature.eyebrow}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.useCaseSection}>
        <span className={styles.eyebrow}>What teams run</span>
        <h2>From code reviews to customer digests.</h2>
        <div className={styles.useCaseGrid}>
          {useCases.map((useCase) => (
            <span key={useCase}>{useCase}</span>
          ))}
        </div>
      </section>

      <section className={styles.controlSection}>
        <div>
          <span className={styles.eyebrow}>Built for real teams</span>
          <h2>Your work, your data, your assistants.</h2>
          <p>
            Self-host Agor, connect the runtimes you already trust, and turn on stronger isolation
            as the stakes grow. Agents can use Agor over MCP, so the system can help operate itself.
          </p>
        </div>
        <ul className={styles.trustList}>
          {trustItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className={styles.finalCta}>
        <h2>Give your team’s AI work a place to live.</h2>
        <p>
          Start with the guide, join the community, or reach out if you’re rolling Agor out for a
          team.
        </p>
        <div className={styles.heroActions}>
          <Link href="/guide" className={styles.primaryButton}>
            Read the docs
          </Link>
          <Link
            href={DISCORD_INVITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.secondaryButton}
          >
            Join Discord
          </Link>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => setIsContactOpen(true)}
          >
            Talk to us →
          </button>
        </div>
      </section>

      <HubSpotFormModal isOpen={isContactOpen} onClose={() => setIsContactOpen(false)} />
    </div>
  );
}
