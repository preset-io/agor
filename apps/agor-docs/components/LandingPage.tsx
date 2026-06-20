import Link from 'next/link';
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
  },
  {
    eyebrow: '02',
    title: 'Make the learning visible',
    body: 'The whole team can see what each assistant is doing and lift the prompts that work.',
  },
  {
    eyebrow: '03',
    title: 'Let work happen on schedule',
    body: 'Run audits, standups, grooming, digests, reviews, and reports instead of waiting to be asked.',
  },
  {
    eyebrow: '04',
    title: 'Keep ownership and control',
    body: 'Model assistants like team members: scoped on purpose, governed, observable, and owned together.',
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
    <div className={styles.screenshotCollage} role="img" aria-label="Agor product screenshots">
      <div className={styles.mainScreenshotFrame}>
        <div className={styles.screenshotTopbar}>
          <span />
          <span />
          <span />
        </div>
        {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
        <img
          src="/screenshots/board-hero.png"
          alt="Agor board showing branches on a shared canvas"
        />
      </div>

      <div className={`${styles.floatingScreenshot} ${styles.floatingConversation}`}>
        {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
        <img src="/screenshots/conversation_full_page.png" alt="Agor conversation view" />
      </div>

      <div className={`${styles.floatingScreenshot} ${styles.floatingSessions}`}>
        {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
        <img src="/screenshots/parallel-board-5-sessions.png" alt="Agor parallel session tree" />
      </div>

      <div className={styles.screenshotBadge}>
        <span className={styles.statusDot} />
        <span>Live branches, sessions, agents, and teammates in one place</span>
      </div>
    </div>
  );
}

export function LandingPage() {
  const [isContactOpen, setIsContactOpen] = useState(false);
  const landingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const landing = landingRef.current;
    if (!landing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    let frame = 0;
    const updateParallax = () => {
      frame = 0;
      const progress = Math.min(window.scrollY / 520, 1).toFixed(3);
      landing.style.setProperty('--hero-scroll', progress);
    };

    const onScroll = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(updateParallax);
    };

    updateParallax();
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  return (
    <div ref={landingRef} className={styles.landingShell}>
      <section className={styles.heroSection}>
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
        <span>What works for one person finally reaches everyone</span>
        <div>
          {assistants.map((assistant) => (
            <strong key={assistant}>@{assistant}</strong>
          ))}
        </div>
      </section>

      <section className={styles.problemSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Why teams need a home for AI work</span>
          <h2>Everyone’s cranking with AI. Now make it compound.</h2>
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
          <h2>Raise real assistants, not throwaway agents.</h2>
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
            Self-host Agor, connect the best models and harnesses, and keep your data yours. As the
            stakes grow, add governance, observability, and isolation without locking into one
            vendor.
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
