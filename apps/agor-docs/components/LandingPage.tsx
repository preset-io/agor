'use client';

import {
  Activity,
  Blocks,
  Brain,
  CalendarClock,
  ClipboardList,
  Code2,
  DraftingCompass,
  GitPullRequest,
  Handshake,
  Hash,
  type LucideIcon,
  Megaphone,
  MessagesSquare,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Target,
} from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  AGOR_CLOUD_DEMO_URL,
  AI_ENABLEMENT_POST_URL,
  DISCORD_INVITE_URL,
  GITHUB_REPO_URL,
} from '../lib/links';
import { BRAND_NAME, LOGO_MARK_PATH } from '../lib/siteMetadata';
import Aurora from './Aurora/Aurora';
import { HubSpotFormModal } from './HubSpotFormModal';
import styles from './LandingPage.module.css';

const LANDING_PRIVATE_BETA_URL = 'https://agor.live/blog/agor-cloud#lets-get-cooking';

const featureCards: Array<{
  title: string;
  body: string;
  href: string;
  linkLabel: string;
  icon: LucideIcon;
}> = [
  {
    title: 'Shared memory',
    icon: Brain,
    body: 'Each assistant gets a namespace in the knowledge base: semantically searchable, durable, and shared with the team.',
    href: '/guide/knowledge',
    linkLabel: 'Explore Knowledge',
  },
  {
    title: 'Skills + MCP',
    icon: Blocks,
    body: 'Package repeatable workflows as skills and connect assistants to the MCP servers your team already trusts.',
    href: '/guide/internal-mcp',
    linkLabel: 'See MCP control',
  },
  {
    title: 'Conversational onboarding',
    icon: MessagesSquare,
    body: 'Teach an assistant by talking to it. The programming language is conversation, and the useful parts become reusable context.',
    href: '/guide/assistants',
    linkLabel: 'Read about Assistants',
  },
  {
    title: 'Where your team works',
    icon: Hash,
    body: 'Reach assistants from Slack, GitHub, or wherever work already happens through gateway channels.',
    href: '/guide/message-gateway',
    linkLabel: 'Open Message Gateway',
  },
  {
    title: 'Scheduled agency',
    icon: CalendarClock,
    body: 'Run heartbeats, daily standups, audits, digests, or longer workflows without waiting for a prompt.',
    href: '/guide/scheduler',
    linkLabel: 'Explore Scheduler',
  },
  {
    title: 'Personality + boundaries',
    icon: SlidersHorizontal,
    body: 'Tune voice, style, and level of agency so every assistant knows how bold to be and when to ask first.',
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
    title: 'Persistent assistants',
    body: 'Give long-lived helpers memory, skills, schedules, and team-wide reach beyond one-off prompts.',
    image: '/screenshots/assistants-list.png',
    href: '/guide/assistants',
  },
  {
    title: 'Message gateway',
    body: 'Bring agents into Slack, GitHub, and the threads where your team already coordinates work.',
    image: '/screenshots/marketing/agor-marketing-slack-thread.png',
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
    label: 'Governance & visibility',
    body: 'Keep AI work visible, auditable, and compounding across every team in the org.',
    href: '/guide/boards',
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

// "So much more than a chat box" carousel. The multiplayer collage
// (comment + facepile + cursor screenshots) leads as slide 1.
const showcaseSlides = [
  { label: 'Multiplayer presence', caption: 'live cursors · comments · facepile', collage: true },
  {
    label: 'Spatial boards',
    caption: 'launch board · spatial canvas',
    image: '/screenshots/board-hero.png',
  },
  {
    label: 'Rich agent sessions',
    caption: 'session · tool calls with full context',
    image: '/screenshots/conversation_full_page.png',
  },
  {
    label: 'Message gateway',
    caption: 'slack · @DatAgor picks up the ticket',
    image: '/screenshots/marketing/agor-marketing-slack-thread.png',
  },
];

// Meet the roster — real assistants from our own Agor instance (names and
// jobs are the genuine article), rendered as blips on the Roster Radar.
// `r`/`a` are polar coordinates (radius in radar units, angle in degrees)
// around the scope's center; `status`/`mem` feed the hover tooltip.
type RosterStatus = 'RUNNING' | 'BUSY' | 'IDLE';

const rosterMembers: Array<{
  icon: LucideIcon;
  name: string;
  role: string;
  status: RosterStatus;
  mem: string;
  r: number;
  a: number;
}> = [
  {
    icon: Code2,
    name: 'AgorClaw',
    role: 'Main coding orchestrator',
    status: 'RUNNING',
    mem: '1.8 GB',
    r: 100,
    a: -90,
  },
  {
    icon: DraftingCompass,
    name: 'Preset Architect',
    role: 'Knows every repo and how they fit together',
    status: 'RUNNING',
    mem: '960 MB',
    r: 170,
    a: -58,
  },
  {
    icon: GitPullRequest,
    name: 'GitHub Handler',
    role: 'Tag it on any PR or issue — it takes it from there',
    status: 'IDLE',
    mem: '512 MB',
    r: 190,
    a: 4,
  },
  {
    icon: ClipboardList,
    name: 'Milchick',
    role: 'Chief-of-staff orchestrator',
    status: 'RUNNING',
    mem: '1.2 GB',
    r: 135,
    a: -28,
  },
  {
    icon: Target,
    name: 'Peyton Manning',
    role: 'Sees the whole field, calls the right plays',
    status: 'BUSY',
    mem: '2.1 GB',
    r: 110,
    a: 44,
  },
  {
    icon: Activity,
    name: 'OpEx',
    role: 'Observability & operational excellence',
    status: 'RUNNING',
    mem: '740 MB',
    r: 155,
    a: 92,
  },
  {
    icon: ShieldCheck,
    name: 'patch-bot',
    role: 'Watches new builds of our base images',
    status: 'IDLE',
    mem: '288 MB',
    r: 195,
    a: 138,
  },
  {
    icon: Scale,
    name: 'Saul',
    role: 'Legal, contracts, redlines expert',
    status: 'RUNNING',
    mem: '1.1 GB',
    r: 145,
    a: 182,
  },
  {
    icon: Handshake,
    name: 'Blake',
    role: 'Deal desk expert',
    status: 'BUSY',
    mem: '1.4 GB',
    r: 180,
    a: -134,
  },
  {
    icon: Megaphone,
    name: 'Peggy',
    role: 'Proposes, optimizes, and reviews ad campaigns',
    status: 'RUNNING',
    mem: '890 MB',
    r: 200,
    a: -158,
  },
];

// Radar scope is authored on a 560×560 grid (center 280,280); positions are
// expressed as percentages so the whole scope scales responsively. Values are
// rounded to a fixed precision — full-precision floats serialize differently
// between SSR and the client and trigger hydration mismatches.
const RADAR_SIZE = 560;

const radarPoint = (r: number, a: number): { x: number; y: number } => {
  const rad = (a * Math.PI) / 180;
  return {
    x: Number((((RADAR_SIZE / 2 + r * Math.cos(rad)) / RADAR_SIZE) * 100).toFixed(3)),
    y: Number((((RADAR_SIZE / 2 + r * Math.sin(rad)) / RADAR_SIZE) * 100).toFixed(3)),
  };
};

const radarPosition = (r: number, a: number): CSSProperties => {
  const { x, y } = radarPoint(r, a);
  return { left: `${x}%`, top: `${y}%` };
};

// Tooltip anchoring: clamp the card's center away from the scope's edge so it
// clears the circular overflow clip, and flip it below the blip for members in
// the top region (no headroom above). The arrow slides back over the blip via
// a container-query offset (cqw = 1% of the scope's width).
const TOOLTIP_CLAMP_PCT = 23;

const radarTooltip = (r: number, a: number): { style: CSSProperties; below: boolean } => {
  const { x, y } = radarPoint(r, a);
  const clampedX = Math.min(100 - TOOLTIP_CLAMP_PCT, Math.max(TOOLTIP_CLAMP_PCT, x));
  return {
    below: y < 40,
    style: {
      left: `${clampedX}%`,
      top: `${y}%`,
      '--tooltip-arrow-dx': `${Number((x - clampedX).toFixed(3))}cqw`,
    } as CSSProperties,
  };
};

const rosterStatusColor: Record<RosterStatus, string> = {
  RUNNING: '#5fe9d0',
  BUSY: '#56c7e8',
  IDLE: '#e8c468',
};

// Multiplayer numbered cards (mockup design language, our copy)
const liveCards = [
  {
    title: 'Live presence',
    body: 'Cursors, comments, and reactions as work happens — from humans and AI teammates on the same board.',
  },
  {
    title: 'Shared dev environments',
    body: 'Engineers, reviewers, PMs, and QA rally around the same running branch instead of “spin up your own to see it.”',
  },
  {
    title: 'Learn from each other',
    body: 'Watch how teammates prompt, lift the patterns that work, and standardize them as zone triggers.',
  },
];

export function LandingPage() {
  const landingRef = useRef<HTMLDivElement>(null);
  const [isBetaFormOpen, setIsBetaFormOpen] = useState(false);
  const [activeShot, setActiveShot] = useState(0);
  const [activeSurface, setActiveSurface] = useState(0);
  const [activeFeature, setActiveFeature] = useState(0);
  const [hoveredMember, setHoveredMember] = useState<number | null>(null);

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
      <div className={styles.heroBanner}>
        {/* Looping product demo as the hero backdrop. Sources are a viewport
            ladder — browsers pick the first matching media query. Falls back
            to the poster frame under prefers-reduced-motion (CSS hides the
            video element; the poster is the layer's background image). */}
        <div className={styles.heroVideo} aria-hidden="true">
          <video
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster="/videos/agor-hero-poster.jpg"
          >
            <source src="/videos/agor-hero-540.mp4" type="video/mp4" media="(max-width: 720px)" />
            <source src="/videos/agor-hero-720.mp4" type="video/mp4" media="(max-width: 1280px)" />
            <source src="/videos/agor-hero.mp4" type="video/mp4" />
          </video>
        </div>
        <section className={styles.heroSection}>
          <div className={styles.heroCopy} data-reveal>
            <p className={styles.heroBadge}>
              Agor
              <span className={styles.badgeDot} aria-hidden="true" />
              The command center for AI enablement
            </p>
            <h1>
              Empower your <span className={styles.headingStrong}>team</span> with{' '}
              <span className={styles.headingAccent}>AI teammates</span>
            </h1>
            <div className={styles.heroActions}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => setIsBetaFormOpen(true)}
              >
                Join the Agor Cloud private beta
              </button>
              <Link href="/guide/getting-started" className={styles.secondaryButton}>
                Install locally
              </Link>
              <Link
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.secondaryButton}
              >
                <GitHubIcon />
                Star us on GitHub
              </Link>
            </div>
          </div>
        </section>
      </div>

      <div className={styles.auroraBand}>
        <div className={styles.bandAurora} aria-hidden="true">
          {/* Warm ramp sampled from the demo board's background — ambient
              edge-light echo of the hero video, TV-backlight style. */}
          <Aurora colorStops={['#f12711', '#f5af19', '#ffd166']} amplitude={0.9} blend={1} />
        </div>
        <section className={styles.liveSection} data-reveal>
          <h2 className={styles.liveStatement}>
            Set your team <span className={styles.headingStrong}>free</span> from{' '}
            <span className={styles.headingAccent}>the terminal</span>
          </h2>
          <p className={styles.liveSub}>
            Don’t let AI tools trap people in their corner.
            <br />
            <span className={styles.headingDim}>
              Agor puts your whole team on one live,{' '}
              <span className={styles.headingAccent}>multiplayer canvas</span>.
            </span>
          </p>
          <div className={styles.liveGrid}>
            {liveCards.map((card, index) => (
              <article
                className={styles.numberedCard}
                key={card.title}
                data-reveal
                style={revealDelay(index)}
              >
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
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
      </div>

      <section className={styles.showcaseSection} data-reveal>
        <div className={styles.showcaseHeader}>
          <div className={styles.sectionHeader}>
            <h2>
              So much <span className={styles.headingStrong}>more</span> than a{' '}
              <span className={styles.headingAccent}>chat box</span>
            </h2>
          </div>
          <div className={styles.showcaseTabs}>
            {showcaseSlides.map((slide, index) => (
              <button
                type="button"
                key={slide.label}
                className={
                  index === activeShot
                    ? `${styles.showcaseTab} ${styles.showcaseTabActive}`
                    : styles.showcaseTab
                }
                onClick={() => setActiveShot(index)}
              >
                {slide.label}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.showcaseFrame}>
          <div className={styles.showcaseChrome}>
            <span className={styles.chromeDot} style={{ background: '#ff6f5e' }} />
            <span className={styles.chromeDot} style={{ background: '#ffd166' }} />
            <span className={styles.chromeDot} style={{ background: '#34e6c4' }} />
            <span className={styles.chromeCaption}>{showcaseSlides[activeShot].caption}</span>
          </div>
          <div className={styles.showcaseViewport}>
            {/* Track is 400% wide with 25% slides — keep in sync with showcaseSlides.length */}
            <div
              className={styles.showcaseTrack}
              style={{ transform: `translateX(-${activeShot * 25}%)` }}
            >
              {showcaseSlides.map((slide) => (
                <div className={styles.showcaseSlide} key={slide.label}>
                  {slide.collage ? (
                    <div className={styles.slideCollage}>
                      {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
                      <img
                        className={styles.slideCollageMain}
                        src="/screenshots/marketing/agor-marketing-social-comment-context.png"
                        alt="Board comment attached to an active Agor branch card"
                      />
                      {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
                      <img
                        className={styles.slideCollageFacepile}
                        src="/screenshots/marketing/agor-marketing-facepile-tooltip.png"
                        alt="Agor facepile with overflow and active teammate tooltip"
                      />
                      {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
                      <img
                        className={styles.slideCollageCursor}
                        src="/screenshots/marketing/agor-marketing-cursor-indicator.png"
                        alt="Live cursor indicator showing Mina on the board"
                      />
                    </div>
                  ) : (
                    /* biome-ignore lint/performance/noImgElement: Static product screenshot */
                    <img className={styles.slideImage} src={slide.image} alt={slide.label} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.workspaceSection} data-reveal>
        <div className={styles.workspaceCopy}>
          <span className={styles.eyebrow}>Agents that learn with you</span>
          <h2>
            Raise <span className={styles.headingAccent}>team assistants</span> with memory, skills,
            and a place to <span className={styles.headingStrong}>work</span>
          </h2>
          <p>
            One-off prompts don’t compound. In Agor, assistants have durable identities your team
            can teach conversationally, then equip with memory, tools, channels, and schedules as
            they grow — so your{' '}
            <Link href={AI_ENABLEMENT_POST_URL} target="_blank" rel="noopener noreferrer">
              most AI-enabled teammates
            </Link>{' '}
            can uplevel workflows across the entire org, and what works for one person finally
            reaches everyone.
          </p>
        </div>
        <div className={styles.featureRing} data-reveal>
          <div className={styles.ringStage}>
            {featureCards.map((feature, index) => {
              const angle = ((-90 + index * (360 / featureCards.length)) * Math.PI) / 180;
              const radius = 37.5; // percent of stage, from center to node center
              const left = 50 + radius * Math.cos(angle);
              const top = 50 + radius * Math.sin(angle);
              const isActive = index === activeFeature;
              return (
                <button
                  type="button"
                  key={feature.title}
                  className={
                    isActive ? `${styles.ringNode} ${styles.ringNodeActive}` : styles.ringNode
                  }
                  style={{ left: `${left}%`, top: `${top}%` }}
                  onMouseEnter={() => setActiveFeature(index)}
                  onFocus={() => setActiveFeature(index)}
                  onClick={() => setActiveFeature(index)}
                  aria-pressed={isActive}
                >
                  <feature.icon size={16} aria-hidden />
                  <span>{feature.title}</span>
                </button>
              );
            })}
            <div className={styles.ringHub}>
              <div className={styles.ringHubInner} key={activeFeature}>
                <p>{featureCards[activeFeature].body}</p>
                <Link href={featureCards[activeFeature].href} className={styles.ringButton}>
                  {featureCards[activeFeature].linkLabel} <span aria-hidden="true">→</span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.productShowcase} data-reveal>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Let power users get down to business</span>
          <h2>
            Every surface <span className={styles.headingStrong}>AI enablers</span> need to{' '}
            <span className={styles.headingAccent}>orchestrate AI</span>
          </h2>
        </div>
        <div className={styles.surfaceExplorer} data-reveal>
          <div className={styles.surfaceRail}>
            <span className={styles.surfaceRailLabel}>Product surfaces</span>
            {productPreviews.map((preview, index) => (
              <button
                type="button"
                key={preview.title}
                className={
                  index === activeSurface
                    ? `${styles.surfaceRailItem} ${styles.surfaceRailItemActive}`
                    : styles.surfaceRailItem
                }
                onClick={() => setActiveSurface(index)}
              >
                {preview.title}
              </button>
            ))}
          </div>
          <div className={styles.surfaceStage}>
            <div className={styles.surfaceInfo}>
              <div>
                <h3>{productPreviews[activeSurface].title}</h3>
                <p>{productPreviews[activeSurface].body}</p>
              </div>
              <Link href={productPreviews[activeSurface].href} className={styles.secondaryButton}>
                Learn more →
              </Link>
            </div>
            {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
            <img
              key={productPreviews[activeSurface].image}
              className={styles.surfaceShot}
              src={productPreviews[activeSurface].image}
              alt={productPreviews[activeSurface].title}
            />
          </div>
        </div>
      </section>

      <section className={styles.rosterSection} data-reveal>
        <div className={styles.rosterCopy}>
          <div className={styles.sectionHeader}>
            <span className={styles.eyebrow}>Meet the Preset agent team</span>
            <h2>
              Full agentic <span className={styles.headingAccent}>coverage</span> for your org.
            </h2>
          </div>
          <p className={styles.rosterBody}>
            The teammates running in our own Agor instance today — each with a name, a job, and a
            memory.
          </p>
          <p className={styles.rosterStatusLine}>
            <span className={styles.rosterStatusDot} aria-hidden="true" />
            {rosterMembers.length} contacts tracked — hover to scan
          </p>
        </div>
        <div className={styles.radarScope}>
          <svg className={styles.radarSvg} viewBox="0 0 560 560" aria-hidden="true">
            <circle cx="280" cy="280" r="100" fill="none" stroke="rgba(94, 233, 208, 0.14)" />
            <circle cx="280" cy="280" r="190" fill="none" stroke="rgba(94, 233, 208, 0.12)" />
            <circle cx="280" cy="280" r="270" fill="none" stroke="rgba(94, 233, 208, 0.1)" />
            <line x1="280" y1="0" x2="280" y2="560" stroke="rgba(94, 233, 208, 0.07)" />
            <line x1="0" y1="280" x2="560" y2="280" stroke="rgba(94, 233, 208, 0.07)" />
          </svg>
          <div className={styles.radarSweep} aria-hidden="true" />
          <div className={styles.radarOrigin} aria-hidden="true">
            <span className={styles.radarOriginDot} />
            <span className={styles.radarOriginLabel}>AGOR</span>
          </div>
          {rosterMembers.map((member, index) => {
            const isDimmed = hoveredMember !== null && hoveredMember !== index;
            const blipClass = [
              styles.radarBlip,
              hoveredMember === index ? styles.radarBlipActive : '',
              isDimmed ? styles.radarBlipDimmed : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                type="button"
                key={member.name}
                className={blipClass}
                style={radarPosition(member.r, member.a)}
                onMouseEnter={() => setHoveredMember(index)}
                onMouseLeave={() => setHoveredMember(null)}
                onFocus={() => setHoveredMember(index)}
                onBlur={() => setHoveredMember(null)}
                aria-label={`${member.name} — ${member.role}`}
              >
                <span className={styles.blipIcon}>
                  <member.icon size={19} aria-hidden />
                </span>
                <span className={styles.blipName}>{member.name}</span>
              </button>
            );
          })}
          {/* Tooltips render as siblings (after all blips) so the active one
              stacks above every blip; visibility toggles via opacity. */}
          {rosterMembers.map((member, index) => {
            const tooltip = radarTooltip(member.r, member.a);
            const tooltipClass = [
              styles.radarTooltip,
              tooltip.below ? styles.radarTooltipBelow : '',
              hoveredMember === index ? styles.radarTooltipVisible : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div
                key={member.name}
                className={tooltipClass}
                style={tooltip.style}
                aria-hidden="true"
              >
                <p className={styles.tooltipName}>{member.name}</p>
                <p className={styles.tooltipRole}>{member.role}</p>
                <div className={styles.tooltipMeta}>
                  <span
                    className={styles.tooltipStatus}
                    style={{ color: rosterStatusColor[member.status] }}
                  >
                    <span className={styles.tooltipStatusDot} />
                    {member.status}
                  </span>
                  <span className={styles.tooltipMem}>mem {member.mem}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className={styles.controlSection} data-reveal>
        <div>
          <span className={styles.eyebrow}>Build teams as a team</span>
          <h2>
            Everyone’s <span className={styles.headingStrong}>using</span> AI.
            <br />
            Now make it <span className={styles.headingAccent}>compound</span>
          </h2>
          <p>
            Agor is built for the{' '}
            <Link href={AI_ENABLEMENT_POST_URL} target="_blank" rel="noopener noreferrer">
              AI Enablement Engineer
            </Link>{' '}
            — the teammate already multiplying everyone around them. Choose the right agent harness,
            keep your data yours, and give your AI leadership one platform to empower the entire org
            with full agentic power.
          </p>
          <div className={styles.controlActions}>
            <Link
              href={AGOR_CLOUD_DEMO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.secondaryButton}
            >
              Talk to us about enterprise
            </Link>
          </div>
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
        <div className={styles.ctaCard}>
          <h2>
            Give your <span className={styles.headingStrong}>AI teammates</span> a place to{' '}
            <span className={styles.headingAccent}>work</span>
          </h2>
          <p>
            Agor Cloud is opening to teams now — or onboard your first AI teammate in three minutes
            with the open-source build.
          </p>
          <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => setIsBetaFormOpen(true)}
            >
              Join the Agor Cloud private beta
            </button>
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
        </div>
      </section>

      <footer className={styles.landingFooter} data-reveal>
        <div className={styles.footerBrand}>
          {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
          <img src={LOGO_MARK_PATH} alt={`${BRAND_NAME} logo`} />
          <div>
            <strong>agor</strong>
            <p>The command center for AI enablement.</p>
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
            <Link href="/guide/assistants">Assistants</Link>
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
              Join the Agor Cloud private beta
            </Link>
          </div>
        </div>
      </footer>

      <HubSpotFormModal
        isOpen={isBetaFormOpen}
        onClose={() => setIsBetaFormOpen(false)}
        title="Join the Agor Cloud private beta"
      />
    </div>
  );
}
