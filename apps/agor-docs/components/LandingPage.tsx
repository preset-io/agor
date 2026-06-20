import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import { BRAND_NAME, LOGO_PATH } from '../lib/siteMetadata';
import { HubSpotFormModal } from './HubSpotFormModal';
import styles from './LandingPage.module.css';

const assistants = ['ReviewBot', 'LaunchOps', 'Scout', 'Standup', 'Docs'];

const problemCards = [
  {
    title: 'My agents are everywhere',
    body: 'More agents, more models, more tabs. Keeping them straight has become its own job.',
  },
  {
    title: 'I can’t see what anyone else is doing',
    body: 'Teammates find great ways to use AI, but prompts and patterns get reinvented in private.',
  },
  {
    title: 'Our AI adoption isn’t going anywhere',
    body: 'Tools were handed out, but there’s no shared place to build assistants together and make them stick.',
  },
  {
    title: 'The bots live on someone’s laptop',
    body: 'Team-critical helpers need ownership, governance, schedules, and observability in one shared place.',
  },
];

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
    body: 'Arrange branches, zones, sessions, and teammates on one live canvas.',
    image: '/screenshots/board-hero.png',
    href: '/guide/boards',
  },
  {
    title: 'Rich agent sessions',
    body: 'Watch tool calls, decisions, reports, and handoffs unfold with full context.',
    image: '/screenshots/conversation_full_page.png',
    href: '/guide/rich-chat-ux',
  },
  {
    title: 'Persistent assistants',
    body: 'Give long-lived helpers memory, skills, schedules, and team-wide reach.',
    image: '/screenshots/assistants-list.png',
    href: '/guide/assistants',
  },
];

const workflowHighlights = [
  {
    eyebrow: 'Spatial board',
    title: 'Figma-like canvas for agentic workflows',
    body: 'Branches become cards, zones become prompts, and teammates can read the state of AI work at a glance.',
    href: '/guide/boards',
  },
  {
    eyebrow: 'Message gateway',
    title: 'Your agents in Slack, GitHub, and wherever work happens',
    body: 'DM Agor or mention it on a PR. Sessions start on the right branch and route the answer back to the thread.',
    href: '/guide/message-gateway',
  },
  {
    eyebrow: 'Automation',
    title: 'Schedulers and artifacts for repeatable work',
    body: 'Run standups, audits, and reports on a cadence — or let agents render live dashboards and tools on the board.',
    href: '/guide/scheduler',
  },
  {
    eyebrow: 'Grown-up agent ops',
    title: 'Governance, observability, and MCP-native control',
    body: 'Track sessions, tools, and spend; let agents operate Agor itself; add RBAC and Unix isolation when stakes rise.',
    href: '/guide/internal-mcp',
  },
  {
    eyebrow: 'Environments',
    title: 'One dev server per branch, without port fights',
    body: 'Start, stop, health-check, and inspect logs for every branch environment from the same shared workspace.',
    href: '/guide/environment-configuration',
  },
];

const useCases = [
  { label: 'multi-agent code review', href: '/guide/sessions' },
  { label: 'release audits', href: '/guide/scheduler' },
  { label: 'backlog grooming', href: '/blog/raise-team-helper-agent' },
  { label: 'security sweeps', href: '/guide/multiplayer-unix-isolation' },
  { label: 'competitive intel', href: '/guide/assistants' },
  { label: 'customer digests', href: '/guide/message-gateway' },
  { label: 'weekly reports', href: '/guide/scheduler' },
  { label: 'standups', href: '/blog/raise-team-helper-agent' },
];

const trustItems = [
  { label: 'Self-hosted first', href: '/guide/getting-started' },
  { label: 'MCP-native', href: '/guide/internal-mcp' },
  { label: 'Claude Code · Codex · Gemini', href: '/guide/sdk-comparison' },
  { label: 'Unix-level isolation when you need it', href: '/guide/multiplayer-unix-isolation' },
];

const revealDelay = (index: number): CSSProperties =>
  ({ '--reveal-delay': `${index * 70}ms` }) as CSSProperties;

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
  const [isContactOpen, setIsContactOpen] = useState(false);
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
            <p className={styles.heroDescription}>
              Everyone’s cranking with AI.
              <br />
              But it’s chaos: scattered sessions, ephemeral context, nothing that compounds. Agor is
              where your team raises real assistants, wires them into the systems you live in, and
              watches the work happen in one shared place.
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
          <div data-reveal style={revealDelay(1)}>
            <ProductMockup />
          </div>
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

      <section className={styles.problemSection} data-reveal>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Why teams need a home for AI work</span>
          <h2>Everyone’s cranking with AI. Now make it compound.</h2>
        </div>
        <div className={styles.problemGrid}>
          {problemCards.map((card) => (
            <article
              className={styles.problemCard}
              key={card.title}
              data-reveal
              style={revealDelay(problemCards.indexOf(card))}
            >
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
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

      <section className={styles.productShowcase} data-reveal>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Product surfaces</span>
          <h2>Show the work, not an abstraction.</h2>
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
                <span>Open guide →</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className={styles.capabilitySection} data-reveal>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Why it becomes a command center</span>
          <h2>The product is bigger than a chat window.</h2>
        </div>
        <div className={styles.capabilityGrid}>
          {workflowHighlights.map((highlight, index) => (
            <Link
              className={styles.capabilityCard}
              href={highlight.href}
              key={highlight.title}
              data-reveal
              style={revealDelay(index)}
            >
              <span>{highlight.eyebrow}</span>
              <h3>{highlight.title}</h3>
              <p>{highlight.body}</p>
              <strong>Explore →</strong>
            </Link>
          ))}
        </div>
      </section>

      <section className={styles.useCaseSection} data-reveal>
        <span className={styles.eyebrow}>What teams run</span>
        <h2>From code reviews to customer digests.</h2>
        <div className={styles.useCaseGrid}>
          {useCases.map((useCase) => (
            <Link href={useCase.href} key={useCase.label}>
              {useCase.label}
            </Link>
          ))}
        </div>
      </section>

      <section className={styles.controlSection} data-reveal>
        <div>
          <span className={styles.eyebrow}>Built for real teams</span>
          <h2>Your work, your data, your assistants.</h2>
          <p>
            Self-host Agor, connect the best models and harnesses, and keep your data yours. As the
            stakes grow, add governance, observability, and isolation without locking into one
            vendor.
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
          Start with the guide, join the community, or reach out if you’re rolling Agor out for a
          team.
        </p>
        <div className={styles.heroActions}>
          <Link href="/guide" className={styles.primaryButton}>
            Read the docs
          </Link>
          <Link href="/guide/features-overview" className={styles.secondaryButton}>
            Feature map
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
