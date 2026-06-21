import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useEffect, useRef } from 'react';
import { AGOR_CLOUD_DEMO_URL, AGOR_CLOUD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import { BRAND_NAME, LOGO_PATH } from '../lib/siteMetadata';
import styles from './LandingPage.module.css';

const assistants = ['ReviewBot', 'LaunchOps', 'Scout', 'Standup', 'Docs'];

const featureCards = [
  {
    eyebrow: '01',
    title: 'Give each assistant a real job',
    body: 'Define what it’s for, give it memory, and wire it into the systems your team already uses.',
    href: '/guide/assistants',
    linkLabel: 'Read about Assistants',
  },
  {
    eyebrow: '02',
    title: 'Make the learning visible',
    body: 'The whole team can see what each assistant is doing and lift the prompts that work.',
    href: '/guide/multiplayer-social',
    linkLabel: 'See multiplayer',
  },
  {
    eyebrow: '03',
    title: 'Let work happen on schedule',
    body: 'Run audits, standups, grooming, digests, reviews, and reports instead of waiting to be asked.',
    href: '/guide/scheduler',
    linkLabel: 'Explore Scheduler',
  },
  {
    eyebrow: '04',
    title: 'Keep ownership and control',
    body: 'Model assistants like team members: scoped on purpose, governed, observable, and owned together.',
    href: '/blog/agent-modeling-101',
    linkLabel: 'Agent modeling 101',
  },
];

const productPreviews = [
  {
    title: 'Spatial boards',
    body: 'Arrange branches, zones, sessions, and teammates on one Figma-like canvas for agentic workflows.',
    image: '/screenshots/board-hero.png',
    href: '/guide/boards',
  },
  {
    title: 'Rich agent sessions',
    body: 'Watch tool calls, decisions, session trees, forks, subsessions, and handoffs unfold with full context.',
    image: '/screenshots/conversation_full_page.png',
    href: '/guide/rich-chat-ux',
  },
  {
    title: 'Persistent assistants',
    body: 'Give long-lived helpers memory, skills, schedules, and team-wide reach beyond one-off prompts.',
    image: '/screenshots/assistants-list.png',
    href: '/guide/assistants',
  },
  {
    title: 'Message gateway',
    body: 'Bring agents into Slack, GitHub, and the threads where your team already coordinates work.',
    image: '/screenshots/subsession-spawn-codex-review.png',
    href: '/guide/message-gateway',
  },
  {
    title: 'Scheduler',
    body: 'Run standups, audits, digests, reports, and assistant heartbeats without waiting to be asked.',
    image: '/screenshots/scheduler-modal.png',
    href: '/guide/scheduler',
  },
  {
    title: 'Artifacts',
    body: 'Let agents render live dashboards, mockups, calculators, and tools directly on the board.',
    image: '/images/artifacts-hero.png',
    href: '/guide/artifacts',
  },
  {
    title: 'Built-in knowledge base',
    body: 'Give humans and agents one shared place for decisions, runbooks, prompts, memory, and reusable context.',
    image: '/images/knowledge-hero.png',
    href: '/guide/knowledge',
  },
  {
    title: 'Branch environments',
    body: 'Start, stop, health-check, and inspect logs for every branch environment without port fights.',
    image: '/screenshots/env_configuration.png',
    href: '/guide/environment-configuration',
  },
  {
    title: 'MCP-native control',
    body: 'Anything a user can do in Agor, an agent can do too: spawn peers, move work, schedule runs, and report back.',
    image: '/screenshots/mcp_environment.png',
    href: '/guide/internal-mcp',
  },
];

const trustItems = [
  { label: 'Agor Cloud is coming', href: '/blog/agor-cloud' },
  { label: 'Open source / self-hosted', href: '/guide/getting-started' },
  { label: 'MCP-native', href: '/guide/internal-mcp' },
  { label: 'Best harnesses, no frontier lock-in', href: '/guide/sdk-comparison' },
  { label: 'Unix-level isolation when you need it', href: '/guide/multiplayer-unix-isolation' },
];

const revealDelay = (index: number): CSSProperties =>
  ({ '--reveal-delay': `${index * 70}ms` }) as CSSProperties;

function GitHubIcon() {
  return (
    <svg className={styles.githubIcon} aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function ProductMockup() {
  return (
    <div className={styles.screenshotCollage} role="img" aria-label="Agor product screenshots">
      <div className={styles.mainScreenshotFrame}>
        {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
        <img
          src="/screenshots/board-hero.png"
          alt="Agor board showing colorful zones and branch cards on a shared canvas"
        />
      </div>
    </div>
  );
}

export function LandingPage() {
  const landingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const landing = landingRef.current;
    if (!landing) {
      return;
    }

    const revealItems = Array.from(landing.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!revealItems.length) {
      return;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealItems.forEach((item) => {
        item.classList.add(styles.isVisible);
      });
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add(styles.isVisible);
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.14 }
    );

    revealItems.forEach((item) => {
      observer.observe(item);
    });

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={landingRef} className={styles.landingShell}>
      <section className={styles.heroSection}>
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy} data-reveal>
            <div className={styles.brandMark}>
              {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
              <img src={LOGO_PATH} alt={`${BRAND_NAME} logo`} />
              <span>agor</span>
            </div>
            <p className={styles.kicker}>Team command center for all things agentic.</p>
            <h1>Meet your team of AI assistants.</h1>
            <p className={styles.heroProvocation}>
              Break out of the terminal.
              <br />
              Bring the team and agents together.
            </p>
            <div className={styles.heroActions}>
              <Link
                href={AGOR_CLOUD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.primaryButton}
              >
                Join the private beta
              </Link>
              <Link href="/guide/getting-started" className={styles.secondaryButton}>
                Try locally
              </Link>
              <Link
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.textButton}
              >
                <GitHubIcon />
                View GitHub
              </Link>
            </div>
          </div>
          <div data-reveal style={revealDelay(1)}>
            <ProductMockup />
          </div>
        </div>
      </section>

      <section className={styles.productShowcase} data-reveal>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Product surfaces</span>
          <h2>This product is much bigger than a chat window.</h2>
        </div>
        <div className={styles.productGrid}>
          {productPreviews.map((preview, index) => (
            <Link
              className={styles.productCard}
              href={preview.href}
              key={preview.title}
              data-reveal
              style={revealDelay(index)}
            >
              {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
              <img src={preview.image} alt="" />
              <div>
                <h3>{preview.title}</h3>
                <p>{preview.body}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className={styles.assistantStrip} aria-label="Example assistants" data-reveal>
        <span>What works for one person finally reaches everyone</span>
        <div>
          {assistants.map((assistant) => (
            <strong key={assistant}>@{assistant}</strong>
          ))}
        </div>
      </section>

      <section className={styles.workspaceSection} data-reveal>
        <div className={styles.workspaceCopy}>
          <span className={styles.eyebrow}>The shared workspace</span>
          <h2>Raise real assistants, not throwaway agents.</h2>
          <p>
            Agor gives your team one place to launch assistants, teach them the workflows that
            matter, coordinate live work, and turn the patterns that work into shared muscle.
          </p>
          <div className={styles.workspaceScreenshot}>
            {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
            <img
              src="/screenshots/assistants-list.png"
              alt="Agor assistants list showing persistent team assistants"
            />
          </div>
        </div>
        <div className={styles.featureGrid}>
          {featureCards.map((feature) => (
            <article
              className={styles.featureCard}
              key={feature.title}
              data-reveal
              style={revealDelay(featureCards.indexOf(feature))}
            >
              <span>{feature.eyebrow}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <Link href={feature.href} className={styles.cardLink}>
                {feature.linkLabel} →
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.controlSection} data-reveal>
        <div>
          <span className={styles.eyebrow}>Built for real teams</span>
          <h2>
            Everyone’s cranking with AI.
            <br />
            Now make it compound.
          </h2>
          <p>
            Choose the right agent harness, keep your data yours, and move from solo experiments to
            team-visible workflows without locking into one frontier.
          </p>
        </div>
        <ul className={styles.trustList}>
          {trustItems.map((item) => (
            <li key={item.label}>
              <Link href={item.href}>{item.label} →</Link>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.finalCta} data-reveal>
        <h2>Give your team’s AI work a place to live.</h2>
        <p>
          Join the private beta, book a demo for Agor Cloud, or install the open-source version
          locally.
        </p>
        <div className={styles.heroActions}>
          <Link
            href={AGOR_CLOUD_INVITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.primaryButton}
          >
            Join the private beta
          </Link>
          <Link
            href={AGOR_CLOUD_DEMO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.secondaryButton}
          >
            Book a demo
          </Link>
          <Link href="/guide/getting-started" className={styles.secondaryButton}>
            Try locally
          </Link>
        </div>
      </section>
    </div>
  );
}
