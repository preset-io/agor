'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useEffect, useRef } from 'react';
import { AGOR_CLOUD_DEMO_URL, DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import { BRAND_NAME, LOGO_PATH } from '../lib/siteMetadata';
import styles from './LandingPage.module.css';

const LANDING_PRIVATE_BETA_URL = 'https://agor.live/blog/agor-cloud#lets-get-cooking';

const featureCards = [
  {
    title: 'Shared memory',
    body: 'Each AI teammate gets a namespace in the knowledge base: semantically searchable, durable, and shared with the team.',
    href: '/guide/knowledge',
    linkLabel: 'Explore Knowledge',
  },
  {
    title: 'Skills + MCP',
    body: 'Package repeatable workflows as skills and connect teammates to the MCP servers your team already trusts.',
    href: '/guide/internal-mcp',
    linkLabel: 'See MCP control',
  },
  {
    title: 'Conversational onboarding',
    body: 'Teach an AI teammate by talking to it. The programming language is conversation, and the useful parts become reusable context.',
    href: '/guide/teammates',
    linkLabel: 'Read about Teammates',
  },
  {
    title: 'Where your team works',
    body: 'Reach teammates from Slack, GitHub, or wherever work already happens through gateway channels.',
    href: '/guide/message-gateway',
    linkLabel: 'Open Message Gateway',
  },
  {
    title: 'Scheduled agency',
    body: 'Run heartbeats, daily standups, audits, digests, or longer workflows without waiting for a prompt.',
    href: '/guide/scheduler',
    linkLabel: 'Explore Scheduler',
  },
  {
    title: 'Personality + boundaries',
    body: 'Tune voice, style, and level of agency so every teammate knows how bold to be and when to ask first.',
    href: '/blog/agent-modeling-101',
    linkLabel: 'Agent modeling 101',
  },
];
const productPreviews = [
  {
    title: 'Spatial boards',
    body: 'Arrange branches, zones, sessions, and teammates on one spatial canvas for agentic workflows.',
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
    title: 'Persistent AI teammates',
    body: 'Give long-lived helpers memory, skills, schedules, and team-wide reach beyond one-off prompts.',
    image: '/screenshots/teammates-list.png',
    href: '/guide/teammates',
  },
  {
    title: 'Message gateway',
    body: 'Bring agents into Slack, GitHub, and the threads where your team already coordinates work.',
    image: '/screenshots/marketing/agor-marketing-slack-thread.png',
    href: '/guide/message-gateway',
  },
  {
    title: 'Scheduler',
    body: 'Run standups, audits, digests, reports, and teammate heartbeats without waiting to be asked.',
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

// Harnesses with an executor handler in packages/executor/src/sdk-handlers.
// Logos mirror the in-app ToolIcon set (apps/agor-ui/src/assets/tools), copied
// into this app's public/tools. Cursor is in beta and has no logo asset yet —
// it falls back to its ⌘ glyph until one lands.
const harnesses: Array<{ name: string; logo?: string; glyph?: string; beta?: boolean }> = [
  { name: 'Claude Code', logo: '/tools/claude-code.png' },
  { name: 'Codex', logo: '/tools/codex.png' },
  { name: 'Gemini', logo: '/tools/gemini.png' },
  { name: 'Copilot', logo: '/tools/copilot.png' },
  { name: 'OpenCode', logo: '/tools/opencode.png' },
  { name: 'Cursor', logo: '/tools/cursor.png', beta: true },
];

const trustItems = [
  {
    label: 'Open source & self-hosted',
    body: 'Your repos, your database, your infrastructure. BSL 1.1.',
    href: '/guide/getting-started',
  },
  {
    label: 'No frontier lock-in',
    body: 'Claude Code, Codex, Gemini, Copilot, OpenCode. Pick the best harness per session, on your own provider subscription.',
    href: '/guide/sdk-comparison',
  },
  {
    label: 'MCP-native',
    body: 'Anything you can do, an agent can do too, over Agor’s own MCP server.',
    href: '/guide/internal-mcp',
  },
  {
    label: 'Unix-level isolation',
    body: 'Progressive isolation modes for when teams and security demand it.',
    href: '/guide/multiplayer-unix-isolation',
  },
  {
    label: 'Agor Cloud is coming',
    body: 'Managed hosting for teams who’d rather not run it themselves.',
    href: '/blog/agor-cloud',
  },
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
          alt="Agor board showing live cursors, rich branch cards, zones, and agent dashboards"
        />
      </div>
    </div>
  );
}

function MultiplayerCollage() {
  return (
    <div
      className={styles.socialCollage}
      role="img"
      aria-label="Agor multiplayer presence with facepile, board comments, and live collaboration"
    >
      {/* biome-ignore lint/performance/noImgElement: Static product screenshot collage */}
      <img
        className={styles.socialMain}
        src="/screenshots/marketing/agor-marketing-social-comment-context.png"
        alt="Board comment attached to an active Agor branch card"
      />
      {/* biome-ignore lint/performance/noImgElement: Static product screenshot collage */}
      <img
        className={styles.socialFacepile}
        src="/screenshots/marketing/agor-marketing-facepile-tooltip.png"
        alt="Agor facepile with overflow and active teammate tooltip"
      />
      {/* biome-ignore lint/performance/noImgElement: Static product screenshot collage */}
      <img
        className={styles.socialCursor}
        src="/screenshots/marketing/agor-marketing-cursor-indicator.png"
        alt="Live cursor indicator showing Mina on the board"
      />
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
            <p className={styles.kicker}>Team command center for all things agentic.</p>
            <h1>Meet your AI teammates.</h1>
            <p className={styles.heroProvocation}>
              Break out of the terminal.
              <br />
              Bring your team and agents together.
            </p>
            <div className={styles.heroActions}>
              <Link
                href={LANDING_PRIVATE_BETA_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.primaryButton}
              >
                Join the private beta
              </Link>
              <Link href="/guide/getting-started" className={styles.secondaryButton}>
                Get started
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
            <p className={styles.heroMeta}>
              Open source. Try it today with a 3-minute local install.
            </p>
          </div>
          <div data-reveal style={revealDelay(1)}>
            <ProductMockup />
          </div>
        </div>
      </section>

      <section className={styles.harnessStrip} data-reveal>
        <span className={styles.harnessLabel}>Built on the harnesses you already use</span>
        <ul className={styles.harnessList}>
          {harnesses.map((harness) => (
            <li className={styles.harnessItem} key={harness.name}>
              <span className={styles.harnessLogo}>
                {harness.logo ? (
                  // biome-ignore lint/performance/noImgElement: Static brand logo
                  <img src={harness.logo} alt={`${harness.name} logo`} />
                ) : (
                  <span className={styles.harnessGlyph}>{harness.glyph}</span>
                )}
              </span>
              <span className={styles.harnessName}>{harness.name}</span>
              {harness.beta ? <span className={styles.harnessBeta}>Beta</span> : null}
            </li>
          ))}
        </ul>
        <p className={styles.harnessNote}>
          Bring your own provider and subscription. Pick the best harness per session, no lock-in.
          All in a web workspace that leaves the terminal behind.
        </p>
      </section>

      <section className={styles.liveSection} data-reveal>
        <div className={styles.liveCopy}>
          <span className={styles.eyebrow}>Multiplayer by default</span>
          <h2>Your team’s agents on one live, Figma-like canvas.</h2>
          <p>
            Most agent tools are solo. Agor isn’t. Cursors, comments, and a facepile show who’s
            here. Sessions, dev environments, and branches are shared. One link, one running thing,
            everyone looking at the same live work.
          </p>
          <ul className={styles.liveHighlights}>
            <li>
              <strong>Live presence</strong>
              <span>
                See teammates’ cursors, comments, and reactions as work happens, not after the fact.
              </span>
            </li>
            <li>
              <strong>Shared dev environments</strong>
              <span>
                Engineers, reviewers, PMs, and QA rally around the same running branch instead of
                “spin up your own to see it.”
              </span>
            </li>
            <li>
              <strong>Learn from each other</strong>
              <span>
                Watch how teammates prompt, lift the patterns that work, and standardize them as
                zone triggers.
              </span>
            </li>
          </ul>
          <Link href="/guide/multiplayer-social" className={styles.cardLink}>
            Explore multiplayer →
          </Link>
        </div>
        <div className={styles.liveVisual}>
          <MultiplayerCollage />
        </div>
      </section>

      <section className={styles.productShowcase} data-reveal>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Product surfaces</span>
          <h2>So much more than a chat box.</h2>
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

      <section className={styles.workspaceSection} data-reveal>
        <div className={styles.workspaceCopy}>
          <span className={styles.eyebrow}>The shared workspace</span>
          <h2>Raise AI teammates with memory, skills, and a place to work.</h2>
          <p>
            One-off prompts don’t compound. In Agor, AI teammates have durable identities your team
            can teach conversationally, then equip with memory, tools, channels, and schedules as
            they grow, so what works for one person finally reaches the whole team.
          </p>
        </div>
        <div className={styles.featureGrid}>
          {featureCards.map((feature) => (
            <article
              className={styles.featureCard}
              key={feature.title}
              data-reveal
              style={revealDelay(featureCards.indexOf(feature))}
            >
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
          <span className={styles.eyebrow}>Built for teams</span>
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
              <Link href={item.href}>
                <span className={styles.trustLabel}>{item.label} →</span>
                <span className={styles.trustBody}>{item.body}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.finalCta} data-reveal>
        <h2>Give your team’s AI work a place to live.</h2>
        <p>Agor Cloud is opening to teams now. The open-source build is ready when you are.</p>
        <div className={styles.heroActions}>
          <Link
            href={LANDING_PRIVATE_BETA_URL}
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
            Get started
          </Link>
        </div>
      </section>

      <footer className={styles.landingFooter} data-reveal>
        <div className={styles.footerBrand}>
          {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
          <img src={LOGO_PATH} alt={`${BRAND_NAME} logo`} />
          <div>
            <strong>agor</strong>
            <p>Team command center for all things agentic.</p>
            <p className={styles.footerEtymology}>
              <span>AG</span>ent <span>OR</span>chestration
            </p>
          </div>
        </div>
        <div className={styles.footerLinks}>
          <div>
            <h4>Product</h4>
            <Link href="/guide/boards">Boards</Link>
            <Link href="/guide/sessions">Sessions</Link>
            <Link href="/guide/teammates">Teammates</Link>
            <Link href="/guide/internal-mcp">MCP control</Link>
          </div>
          <div>
            <h4>Resources</h4>
            <Link href="/guide/getting-started">Get started</Link>
            <Link href="/guide">Documentation</Link>
            <Link href="/blog/agor-cloud">Agor Cloud</Link>
          </div>
          <div>
            <h4>Community</h4>
            <Link href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
              GitHub
            </Link>
            <Link href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">
              Discord
            </Link>
            <Link href={LANDING_PRIVATE_BETA_URL} target="_blank" rel="noopener noreferrer">
              Join the private beta
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
