'use client';

import {
  Activity,
  Blocks,
  Boxes,
  Brain,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Code2,
  DatabaseZap,
  DraftingCompass,
  EyeOff,
  GitPullRequest,
  Handshake,
  Hash,
  type LucideIcon,
  Megaphone,
  MessagesSquare,
  Repeat,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Unlink,
  UserX,
} from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { AI_ENABLEMENT_POST_URL, DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import { BRAND_NAME, LOGO_MARK_PATH } from '../lib/siteMetadata';
import Aurora from './Aurora/Aurora';
import { HubSpotFormModal } from './HubSpotFormModal';
import { HubSpotMeetingModal } from './HubSpotMeetingModal';
import styles from './LandingPage.module.css';

const LANDING_PRIVATE_BETA_URL = 'https://agor.live/blog/agor-cloud#lets-get-cooking';

// "The problem" cards — the diagnosis before the pitch. Amber accents (see
// .problemCard in the CSS module) mark these as the warning register; the
// mint solution palette arrives at the pivot line below the grid.
const problemCards: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Boxes,
    title: 'Boxed into silos',
    body: 'Agents live in personal terminals, but real processes cut across teams. The work crosses boundaries; the agents can’t.',
  },
  {
    icon: DatabaseZap,
    title: 'Context everywhere, truth nowhere',
    body: 'Knowledge is scattered across repos, docs, and DMs — so agents answer confidently without your business’s actual context.',
  },
  {
    icon: EyeOff,
    title: 'Zero line of sight',
    body: 'Tokens burned isn’t a KPI. Nobody can point to which AI work actually moved the business.',
  },
  {
    icon: Unlink,
    title: 'Married to one model',
    body: 'It’s a multi-model world. Hard-wiring workflows to a single frontier is signing up for tomorrow’s migration.',
  },
  {
    icon: UserX,
    title: 'Multipliers who can’t multiply',
    body: 'AI-enablement skill is scarce and mostly grown in-house — and the few people who have it are stuck doing instead of enabling.',
  },
  {
    icon: Repeat,
    title: 'Efficiency theater',
    body: 'Most AI spend just makes old processes faster — not the business different.',
  },
];

// Static scatter pose per problem card (SSR-safe literals — no randomness).
// --slot-y/--slot-rot/--slot-ml/--slot-z are the resting collision pose;
// --slot-rx/--slot-ry are a subtle 3D "tossed pile" tilt (rotateX/rotateY)
// that only appears in the settled state — cards travel flat and pick the
// tilt up with the impact jolt. --enter-x is how far off to the RIGHT each
// card starts its glide-in; cards FADE IN mid-journey (0→1 over the first
// 200ms) already moving at full speed. All six travel as one straight,
// vertically ALIGNED convoy at the same constant speed (0.75px/ms):
// enter-x = 450px lead travel + 60px per travel gap, so each card runs out
// of road exactly 80ms after the one ahead. The lead brakes at the wall;
// everyone behind plows in at full speed, and each impact knocks the card
// ahead into its resting Y/rotation/3D tilt — see @keyframes
// problemCrash1–6 in the CSS module. --slot-delay only staggers the mobile
// fade-up fallback.
const problemScatterSlots = [
  {
    '--slot-y': '30px',
    '--slot-rot': '-2.4deg',
    '--slot-rx': '2.6deg',
    '--slot-ry': '-4.2deg',
    '--slot-ml': '0px',
    '--slot-z': 3,
    '--slot-delay': '0ms',
    '--enter-x': '450px',
  },
  {
    '--slot-y': '-40px',
    '--slot-rot': '3.1deg',
    '--slot-rx': '-3.4deg',
    '--slot-ry': '3.1deg',
    '--slot-ml': '-24px',
    '--slot-z': 4,
    '--slot-delay': '110ms',
    '--enter-x': '510px',
  },
  {
    '--slot-y': '70px',
    '--slot-rot': '-3deg',
    '--slot-rx': '3.8deg',
    '--slot-ry': '4.6deg',
    '--slot-ml': '-30px',
    '--slot-z': 6,
    '--slot-delay': '220ms',
    '--enter-x': '570px',
  },
  {
    '--slot-y': '-50px',
    '--slot-rot': '2.3deg',
    '--slot-rx': '-2.2deg',
    '--slot-ry': '-5deg',
    '--slot-ml': '-38px',
    '--slot-z': 5,
    '--slot-delay': '330ms',
    '--enter-x': '630px',
  },
  {
    '--slot-y': '20px',
    '--slot-rot': '-1.7deg',
    '--slot-rx': '3.2deg',
    '--slot-ry': '2.4deg',
    '--slot-ml': '-20px',
    '--slot-z': 2,
    '--slot-delay': '440ms',
    '--enter-x': '690px',
  },
  {
    '--slot-y': '-10px',
    '--slot-rot': '2.8deg',
    '--slot-rx': '-3.9deg',
    '--slot-ry': '-3.3deg',
    '--slot-ml': '-28px',
    '--slot-z': 1,
    '--slot-delay': '550ms',
    '--enter-x': '750px',
  },
] as unknown as CSSProperties[];

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
    body: 'Each teammate gets a namespace in the knowledge base: semantically searchable, durable, and shared with the team.',
    href: '/guide/knowledge',
    linkLabel: 'Explore Knowledge',
  },
  {
    title: 'Skills + MCP',
    icon: Blocks,
    body: 'Package repeatable workflows as skills and connect teammates to the MCP servers your team already trusts.',
    href: '/guide/internal-mcp',
    linkLabel: 'See MCP control',
  },
  {
    title: 'Conversational onboarding',
    icon: MessagesSquare,
    body: 'Teach a teammate by talking to it. The programming language is conversation, and the useful parts become reusable context.',
    href: '/guide/teammates',
    linkLabel: 'Read about Teammates',
  },
  {
    title: 'Where your team works',
    icon: Hash,
    body: 'Reach teammates from Slack, GitHub, or wherever work already happens through gateway channels.',
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
    title: 'Persistent teammates',
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

// The "Compound Amplifying Bus": six trust items on a vertical mint spine —
// the deliberate counterpoint to the six amber problem cards piled up in the
// section above (same count, calm straight line). Order is intentional: it
// answers the problem cards in spirit (context moats, tomorrow's migration,
// tokens-not-a-KPI, scarce multipliers, safe openness). Ripple ring sizes
// and delays are static literals (SSR-safe, no randomness): ring count and
// size grow toward the bottom of the line — the "amplifying" effect. Delays
// spread each node's rings evenly across the shared 3s loop.
const busItems: Array<{
  title: string;
  desc: string;
  beta?: boolean;
  rippleSize: number;
  rippleDelays: number[];
}> = [
  {
    title: 'Open source & self-hosted',
    desc: 'Your repos, your database, your infrastructure — nobody’s moat but yours. BSL 1.1.',
    rippleSize: 10,
    rippleDelays: [0, 1500],
  },
  {
    title: 'No frontier lock-in',
    desc: 'Claude Code, Codex, Gemini, Copilot, OpenCode. Pick the best harness per session — and switch the day something better ships.',
    rippleSize: 13,
    rippleDelays: [0, 1000, 2000],
  },
  {
    title: 'Governance & visibility',
    desc: 'One auditable canvas for every session and prompt, so leadership sees outcomes — not token bills.',
    rippleSize: 17,
    rippleDelays: [0, 750, 1500, 2250],
  },
  {
    title: 'MCP-native',
    desc: 'Anything you can do, an agent can do too, over Agor’s own MCP server. Enablement that scales beyond headcount.',
    rippleSize: 20,
    rippleDelays: [0, 600, 1200, 1800, 2400],
  },
  {
    title: 'Unix-level isolation',
    desc: 'Progressive isolation modes that open the canvas to the whole org without handing out the keys.',
    rippleSize: 24,
    rippleDelays: [0, 600, 1200, 1800, 2400],
  },
  {
    title: 'Agor Cloud is coming',
    desc: 'Managed hosting for teams who’d rather not run it themselves — ',
    beta: true,
    rippleSize: 27,
    rippleDelays: [0, 600, 1200, 1800, 2400],
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

// "So much more than a chat box" carousel. Each slide is a short loop-perfect
// demo video rendered by the demo-videos pipeline (apps/agor-docs/demo-videos);
// the poster doubles as the reduced-motion / JS-off fallback.
const showcaseSlides = [
  {
    label: 'Multiplayer presence',
    caption: 'live cursors · shared session · queued follow-up',
    video: '/videos/showcase-multiplayer.mp4',
    poster: '/videos/showcase-multiplayer-poster.jpg',
  },
  {
    label: 'Spatial boards',
    caption: 'launch board · spatial canvas',
    video: '/videos/showcase-boards.mp4',
    poster: '/videos/showcase-boards-poster.jpg',
  },
  {
    label: 'Rich agent sessions',
    caption: 'session · tool calls with full context',
    video: '/videos/showcase-sessions.mp4',
    poster: '/videos/showcase-sessions-poster.jpg',
  },
  {
    label: 'Message gateway',
    caption: 'slack · @Agor picks up the ticket',
    video: '/videos/showcase-gateway.mp4',
    poster: '/videos/showcase-gateway-poster.jpg',
  },
];

// Meet the roster — real teammates from our own Agor instance (names and
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
  const [isDemoFormOpen, setIsDemoFormOpen] = useState(false);
  const [activeShot, setActiveShot] = useState(0);
  const [activeSurface, setActiveSurface] = useState(0);
  const [activeFeature, setActiveFeature] = useState(0);
  const [hoveredMember, setHoveredMember] = useState<number | null>(null);
  const slideVideoRefs = useRef<Array<HTMLVideoElement | null>>([]);

  // Showcase carousel playback gating: only the active slide's video plays;
  // off-screen slides pause (four loops on one page would otherwise decode
  // simultaneously forever). Under prefers-reduced-motion nothing plays — the
  // CSS hides the videos and the poster background shows instead.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    slideVideoRefs.current.forEach((video, index) => {
      if (!video) {
        return;
      }
      if (index === activeShot) {
        video.play().catch(() => {
          // Autoplay can be rejected (e.g. data-saver); the poster still shows.
        });
      } else {
        video.pause();
      }
    });
  }, [activeShot]);

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
                Sign up for Agor Cloud
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

      <section className={styles.problemSection} data-reveal>
        <h2 className={styles.liveStatement}>
          Don&rsquo;t let AI <span className={styles.headingAccentWarm}>silo</span> your{' '}
          <span className={styles.headingStrong}>team</span>
        </h2>
        <p className={styles.liveSub}>
          <span className={styles.headingDim}>
            Disconnected tools, solo wins, no line of sight.
          </span>
        </p>
        {/* Collision composition: slots carry the static scatter pose (rotate/
            translate/negative margins/z-index via CSS vars) plus the crash
            entrance animation, keyed off .problemSection.isVisible — the inner
            .problemCard keeps its own hover behavior. Cards deliberately lack
            data-reveal so the shared reveal transform can't fight the crash
            keyframes. */}
        <div className={styles.problemScatter}>
          {problemCards.map((card, index) => (
            <div className={styles.problemSlot} key={card.title} style={problemScatterSlots[index]}>
              <article className={`${styles.numberedCard} ${styles.problemCard}`}>
                <span className={styles.problemIcon}>
                  <card.icon size={17} aria-hidden />
                </span>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            </div>
          ))}
        </div>
        <p className={styles.problemPivot}>
          Agor helps your team avoid this{' '}
          <span className={styles.headingAccent}>operational nightmare</span>
        </p>
      </section>

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
              {showcaseSlides.map((slide, index) => (
                <div className={styles.showcaseSlide} key={slide.label}>
                  {/* Poster is the frame's background image so it shows under
                      prefers-reduced-motion (CSS hides the video) and with JS
                      off (no play() call ever fires). Only the first slide
                      preloads — four eager mp4s (~5MB) is real weight on a
                      phone; play() on the other slides triggers their fetch
                      when they're actually activated. */}
                  <div
                    className={styles.slideVideoFrame}
                    style={{ backgroundImage: `url(${slide.poster})` }}
                  >
                    <video
                      ref={(element) => {
                        slideVideoRefs.current[index] = element;
                      }}
                      className={styles.slideVideo}
                      muted
                      loop
                      playsInline
                      preload={index === 0 ? 'auto' : 'none'}
                      poster={slide.poster}
                      aria-label={slide.label}
                    >
                      <source src={slide.video} type="video/mp4" />
                    </video>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <button
            type="button"
            aria-label="Previous example"
            className={`${styles.showcaseArrow} ${styles.showcaseArrowLeft}`}
            onClick={() =>
              setActiveShot((activeShot + showcaseSlides.length - 1) % showcaseSlides.length)
            }
          >
            <ChevronLeft size={22} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next example"
            className={`${styles.showcaseArrow} ${styles.showcaseArrowRight}`}
            onClick={() => setActiveShot((activeShot + 1) % showcaseSlides.length)}
          >
            <ChevronRight size={22} aria-hidden />
          </button>
        </div>
      </section>

      <section className={styles.workspaceSection} data-reveal>
        <div className={styles.workspaceCopy}>
          <span className={styles.eyebrow}>Agents that learn with you</span>
          <h2>
            Raise <span className={styles.headingAccent}>AI teammates</span> with memory, skills,
            and a place to <span className={styles.headingStrong}>work</span>
          </h2>
          <p>
            One-off prompts don’t compound. In Agor, teammates have durable identities your team can
            teach conversationally, then equip with memory, tools, channels, and schedules as they
            grow. Your{' '}
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
                  <span className={styles.ringNodeIcon} aria-hidden>
                    <feature.icon size={15} />
                  </span>
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

      {/* Story beat: the problem section's six amber cards in a chaotic pile
          → six mint items on a calm straight line here. The "Compound
          Amplifying Bus". */}
      <section className={styles.controlSection} data-reveal>
        <div>
          <h2>
            You’re <span className={styles.headingStrong}>using</span> AI
            <br />
            Now make it{' '}
            <span className={`${styles.headingAccent} ${styles.compoundWord}`}>compound</span>
          </h2>
          <p>
            Agor is built for the{' '}
            <Link href={AI_ENABLEMENT_POST_URL} target="_blank" rel="noopener noreferrer">
              AI Enablement Engineer
            </Link>
            , acting as a force-multiplier for everyone around them. Give them the ideal platform to
            make every win visible and shared, every pattern reusable, and let your AI leadership
            watch as it compounds.
          </p>
          <div className={styles.controlActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setIsDemoFormOpen(true)}
            >
              Talk to us about enterprise
            </button>
          </div>
        </div>
        <ul className={styles.busList}>
          {busItems.map((item) => (
            <li key={item.title} className={styles.busItem}>
              <span className={styles.busNode} aria-hidden="true">
                {item.rippleDelays.map((delay) => (
                  <i
                    key={delay}
                    className={styles.busRipple}
                    style={
                      {
                        '--ripple-size': `${item.rippleSize}px`,
                        '--ripple-delay': `${delay}ms`,
                      } as CSSProperties
                    }
                  />
                ))}
                <i className={styles.busNodeDot} />
              </span>
              <h3 className={styles.busTitle}>{item.title}</h3>
              <div className={styles.busDesc}>
                {item.desc}
                {item.beta && (
                  <>
                    <button
                      type="button"
                      className={styles.busBetaLink}
                      onClick={() => setIsBetaFormOpen(true)}
                    >
                      register for the Agor Cloud beta
                    </button>
                    .
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

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
            One shared board instead of ten private terminals.
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
              Sign up for Agor Cloud
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setIsDemoFormOpen(true)}
            >
              Book a demo
            </button>
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
              Sign up for Agor Cloud
            </Link>
          </div>
        </div>
        <p className={styles.footerCredit}>
          {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
          <img src="/preset-logo.svg" alt="Preset logo" className={styles.footerCreditLogo} />
          Built by{' '}
          <Link
            href="https://preset.io"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.footerCreditLink}
          >
            Preset, Inc.
          </Link>
        </p>
      </footer>

      <HubSpotFormModal
        isOpen={isBetaFormOpen}
        onClose={() => setIsBetaFormOpen(false)}
        title="Join the Agor Cloud private beta"
      />
      <HubSpotMeetingModal isOpen={isDemoFormOpen} onClose={() => setIsDemoFormOpen(false)} />
    </div>
  );
}
