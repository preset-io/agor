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
  DoorOpen,
  DraftingCompass,
  Eye,
  EyeOff,
  Hammer,
  Handshake,
  Hash,
  type LucideIcon,
  MessagesSquare,
  Repeat,
  Scale,
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
import Orb from './Orb/Orb';

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
// Spatial boards, rich sessions, and the message gateway are deliberately
// absent — the "So much more than a chat box" showcase above already tells
// those stories with video.
const productPreviews = [
  {
    title: 'Persistent teammates',
    body: 'Give long-lived helpers memory, skills, schedules, and team-wide reach beyond one-off prompts.',
    image: '/screenshots/teammates-list.png',
    href: '/guide/teammates',
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
    blurb:
      'Humans and agents share the same board — live cursors, shared sessions, queued follow-ups.',
    video: '/videos/showcase-multiplayer.mp4',
    videoSmall: '/videos/showcase-multiplayer-540.mp4',
    poster: '/videos/showcase-multiplayer-poster.jpg',
  },
  {
    label: 'Spatial boards',
    blurb: 'Arrange branches, zones, sessions, and teammates on one spatial canvas.',
    video: '/videos/showcase-boards.mp4',
    videoSmall: '/videos/showcase-boards-540.mp4',
    poster: '/videos/showcase-boards-poster.jpg',
  },
  {
    label: 'Rich agent sessions',
    blurb: 'Watch tool calls, decisions, and handoffs unfold with full context.',
    video: '/videos/showcase-sessions.mp4',
    videoSmall: '/videos/showcase-sessions-540.mp4',
    poster: '/videos/showcase-sessions-poster.jpg',
  },
  {
    label: 'Message gateway',
    blurb: 'Bring agents into Slack, GitHub, and the threads where your team already works.',
    video: '/videos/showcase-gateway.mp4',
    videoSmall: '/videos/showcase-gateway-540.mp4',
    poster: '/videos/showcase-gateway-poster.jpg',
  },
];

// Meet the roster — real teammates from our own Agor instance (names and
// jobs are the genuine article), rendered as blips on the Roster Radar.
// `r`/`a` are polar coordinates (radius in radar units, angle in degrees)
// around the scope's center; `status`/`mem` feed the hover tooltip.
// Real teammates from the Preset Agor instance — names, jobs, and the meta
// line are the genuine article (usage pulled from instance analytics,
// 2026-07). `meta` is each agent's most interesting true fact.
const rosterMembers: Array<{
  icon: LucideIcon;
  name: string;
  role: string;
  meta: string;
  r: number;
  a: number;
}> = [
  {
    icon: Code2,
    name: 'AgorClaw',
    role: 'Main coding orchestrator — the first assistant in the instance',
    meta: '55B tokens · 1,600+ tasks',
    r: 100,
    a: -90,
  },
  {
    icon: DraftingCompass,
    name: 'Preset Architect',
    role: 'Knows every repo and how they fit together',
    meta: 'weekly release health check',
    r: 170,
    a: -58,
  },
  {
    icon: Eye,
    name: 'Princeton',
    role: 'PR reviewer that learns from your human reviewers',
    meta: 'learns from review comments',
    r: 190,
    a: 4,
  },
  {
    icon: ClipboardList,
    name: 'Milchick',
    role: 'Chief-of-staff orchestrator',
    meta: 'Slack-native · nightly 9pm run',
    r: 135,
    a: -28,
  },
  {
    icon: Target,
    name: 'Peyton Manning',
    role: 'Sees the whole field, routes work to the right people',
    meta: 'labels RC tickets every 4h',
    r: 110,
    a: 44,
  },
  {
    icon: Activity,
    name: 'SRE',
    role: 'Datadog triage, tickets, and production fixes',
    meta: '3 daily crons',
    r: 155,
    a: 92,
  },
  {
    icon: Hammer,
    name: 'Telchar',
    role: 'Opens a ticket, branch, and PR per CVE',
    meta: 'Snyk-fed · never merges alone',
    r: 195,
    a: 138,
  },
  {
    icon: Scale,
    name: 'Saul',
    role: 'Legal, contracts, redlines expert',
    meta: 'Slack-native · on call for redlines',
    r: 145,
    a: 182,
  },
  {
    icon: Handshake,
    name: 'Blake',
    role: 'Deal desk, contracts, and order forms',
    meta: '@-mention him in Slack',
    r: 180,
    a: -134,
  },
  {
    icon: DoorOpen,
    name: 'Hodor!',
    role: 'Agor’s own PM — issues, roadmap, ritual notes',
    meta: 'lives in #agor · attends rituals',
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
  const landingRef = useRef<HTMLElement>(null);
  const [isBetaFormOpen, setIsBetaFormOpen] = useState(false);
  const [isDemoFormOpen, setIsDemoFormOpen] = useState(false);
  const [activeShot, setActiveShot] = useState(0);
  const [activeSurface, setActiveSurface] = useState(0);
  const [activeFeature, setActiveFeature] = useState(0);
  const [hoveredMember, setHoveredMember] = useState<number | null>(null);
  const [radarInView, setRadarInView] = useState(false);
  const radarScopeRef = useRef<HTMLDivElement>(null);
  const [scrollySurface, setScrollySurface] = useState(0);
  const scrollyWrapRef = useRef<HTMLDivElement>(null);
  const scrollyTrackRef = useRef<HTMLDivElement>(null);
  const showcasePinRef = useRef<HTMLElement>(null);
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
          // Very tall sections (e.g. the scroll-locked surface carousel) can
          // never reach the 14% ratio in a phone viewport, so also reveal
          // once the visible slice fills a third of the screen.
          if (
            entry.isIntersecting &&
            (entry.intersectionRatio >= 0.14 ||
              entry.intersectionRect.height >= window.innerHeight * 0.34)
          ) {
            entry.target.classList.add(styles.isVisible);
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: [0, 0.07, 0.14] }
    );

    revealItems.forEach((item) => {
      observer.observe(item);
    });

    return () => observer.disconnect();
  }, []);

  // Scroll-locked surface carousel (phones): while .surfaceScrolly's tall
  // wrapper crosses the viewport, its sticky stage pins and vertical scroll
  // progress maps onto the track's horizontal position. Sticky + transform
  // only — native scrolling is never intercepted, so flicking straight
  // through remains possible. Desktop and reduced-motion phones never match
  // the media query (CSS shows the pill explorer instead).
  useEffect(() => {
    const wrap = scrollyWrapRef.current;
    const track = scrollyTrackRef.current;
    if (!wrap || !track) {
      return;
    }

    const media = window.matchMedia(
      '(max-width: 720px) and (prefers-reduced-motion: no-preference)'
    );
    const count = productPreviews.length;
    let raf = 0;

    const update = () => {
      raf = 0;
      if (!media.matches) {
        track.style.transform = '';
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const range = rect.height - window.innerHeight;
      const progress = range > 0 ? Math.min(1, Math.max(0, -rect.top / range)) : 0;
      // Dwell easing: each card parks flush for ~a third of its scroll
      // segment before handing off, so pausing mid-scroll doesn't strand a
      // card half off-screen.
      const pos = progress * (count - 1);
      const seg = Math.min(count - 2, Math.floor(pos));
      const frac = pos - seg;
      const dwell = 0.32;
      const eased = seg + Math.min(1, Math.max(0, (frac - dwell / 2) / (1 - dwell)));
      track.style.transform = `translateX(${(-eased * 100) / count}%)`;
      setScrollySurface(Math.round(eased));
    };
    const schedule = () => {
      if (!raf) {
        raf = requestAnimationFrame(update);
      }
    };

    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    media.addEventListener('change', schedule);

    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      media.removeEventListener('change', schedule);
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, []);

  // Scroll-locked showcase carousel (phones): the pinned section's scroll
  // progress simply drives setActiveShot, so the track's existing 550ms
  // transition, tab highlighting, caption, and active-video play/pause
  // gating stay on the exact same code path as tap navigation. Rounding to
  // the nearest slide gives natural dwell plateaus between transitions.
  useEffect(() => {
    const pin = showcasePinRef.current;
    if (!pin) {
      return;
    }

    const media = window.matchMedia(
      '(max-width: 720px) and (prefers-reduced-motion: no-preference)'
    );
    const count = showcaseSlides.length;
    let raf = 0;

    const update = () => {
      raf = 0;
      if (!media.matches) {
        return;
      }
      const rect = pin.getBoundingClientRect();
      const range = rect.height - window.innerHeight;
      if (range <= 0) {
        return;
      }
      const progress = Math.min(1, Math.max(0, -rect.top / range));
      setActiveShot(Math.round(progress * (count - 1)));
    };
    const schedule = () => {
      if (!raf) {
        raf = requestAnimationFrame(update);
      }
    };

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);

    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, []);

  // Phones show the radar detail card as a fixed bottom overlay; fade it in
  // only while the radar itself is on screen so it never floats over
  // unrelated sections.
  useEffect(() => {
    const scope = radarScopeRef.current;
    if (!scope) {
      return;
    }
    // Ratio-based (not isIntersecting): the card retires as soon as most of
    // the radar has scrolled away, instead of lingering until the last pixel
    // exits underneath the next section.
    const observer = new IntersectionObserver(
      ([entry]) => setRadarInView(entry.intersectionRatio >= 0.35),
      { threshold: [0, 0.35] }
    );
    observer.observe(scope);
    return () => observer.disconnect();
  }, []);

  return (
    // <main> (not div): the landing page uses Nextra's "full" layout, which
    // provides no main landmark of its own — this is the page's only one.
    // id matches Nextra's "Skip to Content" anchor (#nextra-skip-nav) — the
    // full-page layout omits the docs content wrapper that normally carries it.
    <main ref={landingRef} id="nextra-skip-nav" className={styles.landingShell}>
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
            <p className={styles.heroBadge}>The command center for AI enablement</p>
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
          <span className={styles.headingAccentWarm}>operational nightmare</span>
        </p>
      </section>

      <section className={styles.showcaseSection} data-reveal ref={showcasePinRef}>
        {/* Section divider: the docs pages' mint aurora as a thin curtain
            hanging from the seam with the problem section. */}
        <div className={styles.showcaseDivider} aria-hidden="true">
          <Aurora
            colorStops={['#2e9a92', '#34e6c4', '#7ad9ff']}
            amplitude={0.9}
            blend={1}
            speed={0.6}
          />
        </div>
        {/* On phones the section pins and scroll steps through the slides
            (same scroll-locked treatment as the surface carousel below);
            this wrapper is the sticky stage there and a plain div on
            desktop. */}
        <div className={styles.showcaseSticky}>
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
                  aria-pressed={index === activeShot}
                  onClick={() => setActiveShot(index)}
                >
                  {slide.label}
                </button>
              ))}
            </div>
          </div>
          {/* Phone-only status line — mirrors the surface carousel below
              (tab pills hide on phones; this is the slide indicator). */}
          <div className={styles.showcaseStatus}>
            {/* The "01 / 04" ornament reads poorly aloud; screen readers get a
                plain "Slide 1 of 4" instead. */}
            <span className={styles.scrollyStatusCount} aria-hidden="true">
              {String(activeShot + 1).padStart(2, '0')} /{' '}
              {String(showcaseSlides.length).padStart(2, '0')}
            </span>
            <span className={styles.srOnly}>
              Slide {activeShot + 1} of {showcaseSlides.length}
            </span>
            <span className={styles.scrollyStatusTitle}>{showcaseSlides[activeShot].label}</span>
          </div>
          <div className={styles.showcaseFrame}>
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
                        <source
                          src={slide.videoSmall}
                          type="video/mp4"
                          media="(max-width: 720px)"
                        />
                        <source src={slide.video} type="video/mp4" />
                      </video>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* Invisible click layer: clicking the video advances the reel
                (arrows sit above it at a higher z-index). Hidden on phones,
                where scroll drives the carousel. Mouse-only affordance — the
                visible arrows are the accessible controls, so this stays out
                of the tab order and the accessibility tree. */}
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              className={styles.frameAdvance}
              onClick={() => setActiveShot((activeShot + 1) % showcaseSlides.length)}
            />
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
          {/* Phone-only: header + blurb below the video (mirrors the surface
              carousel's card text), with matching dots. */}
          <div className={styles.showcaseSlideInfo}>
            <h3>{showcaseSlides[activeShot].label}</h3>
            <p>{showcaseSlides[activeShot].blurb}</p>
          </div>
          <div className={styles.showcaseDots} aria-hidden="true">
            {showcaseSlides.map((slide, index) => (
              <span
                key={slide.label}
                className={
                  index === activeShot
                    ? `${styles.scrollyDot} ${styles.scrollyDotActive}`
                    : styles.scrollyDot
                }
              />
            ))}
          </div>
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
            {/* ReactBits orb: its glowing rim threads through the node
                centers, replacing the old 1px dashed guide circle. Sized so
                the rim (~80% of the orb's half-width) lands on the 37.5%
                node radius. */}
            <div className={styles.ringOrb} aria-hidden="true">
              <Orb hue={41} hoverIntensity={0} rotateOnHover forceHoverState={false} />
            </div>
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
        {/* Phone fallback for the ring (hover/click doesn't earn its keep on
            touch): every feature expanded in a scrollable divider list —
            icon left, content right, no interaction required. */}
        <div className={styles.featureList} data-reveal>
          {featureCards.map((feature) => (
            <article key={feature.title} className={styles.featureListItem}>
              <span className={styles.featureListIcon} aria-hidden>
                <feature.icon size={15} />
              </span>
              <div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
                <Link href={feature.href} className={styles.featureListLink}>
                  {feature.linkLabel} <span aria-hidden="true">→</span>
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.productShowcase} data-reveal>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Let power users get down to business</span>
          <h2>
            Every capability <span className={styles.headingStrong}>AI enablers</span> need to{' '}
            <span className={styles.headingAccent}>orchestrate AI</span>
          </h2>
        </div>
        {/* Desktop: same carousel grammar as the showcase above — tab pills,
            chrome frame, sliding track, arrows, click-the-shot-to-advance.
            Track/slide widths are inline because they depend on the entry
            count. Phones hide this and use the scroll-locked treatment
            below. */}
        <div className={styles.surfaceExplorer} data-reveal>
          <div className={styles.showcaseTabs}>
            {productPreviews.map((preview, index) => (
              <button
                type="button"
                key={preview.title}
                className={
                  index === activeSurface
                    ? `${styles.showcaseTab} ${styles.showcaseTabActive}`
                    : styles.showcaseTab
                }
                aria-pressed={index === activeSurface}
                onClick={() => setActiveSurface(index)}
              >
                {preview.title}
              </button>
            ))}
          </div>
          <div className={styles.showcaseFrame}>
            <div className={styles.showcaseViewport}>
              <div
                className={styles.showcaseTrack}
                style={{
                  width: `${productPreviews.length * 100}%`,
                  transform: `translateX(-${activeSurface * (100 / productPreviews.length)}%)`,
                }}
              >
                {productPreviews.map((preview, index) => (
                  <div
                    className={styles.surfaceSlide}
                    key={preview.title}
                    style={{ width: `${100 / productPreviews.length}%` }}
                  >
                    <div className={styles.surfaceInfo}>
                      <div>
                        <h3>{preview.title}</h3>
                        <p>{preview.body}</p>
                      </div>
                      <Link href={preview.href} className={styles.secondaryButton}>
                        Learn more →
                      </Link>
                    </div>
                    <button
                      type="button"
                      className={styles.surfaceShotButton}
                      aria-label="Next capability"
                      onClick={() => setActiveSurface((index + 1) % productPreviews.length)}
                    >
                      {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
                      <img
                        className={styles.surfaceShot}
                        src={preview.image}
                        alt={`Screenshot of ${preview.title} in Agor`}
                        loading={index === 0 ? 'eager' : 'lazy'}
                      />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <button
              type="button"
              aria-label="Previous capability"
              className={`${styles.showcaseArrow} ${styles.showcaseArrowLeft}`}
              onClick={() =>
                setActiveSurface(
                  (activeSurface + productPreviews.length - 1) % productPreviews.length
                )
              }
            >
              <ChevronLeft size={22} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next capability"
              className={`${styles.showcaseArrow} ${styles.showcaseArrowRight}`}
              onClick={() => setActiveSurface((activeSurface + 1) % productPreviews.length)}
            >
              <ChevronRight size={22} aria-hidden />
            </button>
          </div>
        </div>
        {/* Phone treatment (Claude Design scroll-lock-carousel mock): the
            stage pins while vertical scroll drives the cards sideways, then
            hands scrolling back to the page. Heights are inline because they
            depend on the surface count. */}
        <div
          className={styles.surfaceScrolly}
          ref={scrollyWrapRef}
          style={{ height: `calc(${productPreviews.length * 55}dvh + 100dvh)` }}
        >
          <div className={styles.scrollySticky}>
            <div className={styles.scrollyStatus}>
              {/* Same treatment as the showcase status: numeric ornament is
                  hidden from screen readers in favor of plain wording. */}
              <span className={styles.scrollyStatusCount} aria-hidden="true">
                {String(scrollySurface + 1).padStart(2, '0')} /{' '}
                {String(productPreviews.length).padStart(2, '0')}
              </span>
              <span className={styles.srOnly}>
                Slide {scrollySurface + 1} of {productPreviews.length}
              </span>
              <span className={styles.scrollyStatusTitle}>
                {productPreviews[scrollySurface].title}
              </span>
            </div>
            <div
              className={styles.scrollyTrack}
              ref={scrollyTrackRef}
              style={{ width: `${productPreviews.length * 100}%` }}
            >
              {productPreviews.map((preview) => (
                <article
                  key={preview.title}
                  className={styles.scrollyCard}
                  style={{ width: `${100 / productPreviews.length}%` }}
                >
                  {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
                  <img
                    className={styles.scrollyShot}
                    src={preview.image}
                    alt={`Screenshot of ${preview.title} in Agor`}
                    loading="lazy"
                  />
                  <h3>{preview.title}</h3>
                  <p>{preview.body}</p>
                </article>
              ))}
            </div>
            <div className={styles.scrollyDots} aria-hidden="true">
              {productPreviews.map((preview, index) => (
                <span
                  key={preview.title}
                  className={
                    index === scrollySurface
                      ? `${styles.scrollyDot} ${styles.scrollyDotActive}`
                      : styles.scrollyDot
                  }
                />
              ))}
            </div>
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
              Book an Agor demo
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
              Full agentic <span className={styles.headingAccent}>coverage</span> for{' '}
              <span className={styles.headingStrong}>any</span> org
            </h2>
          </div>
          <p className={styles.rosterBody}>
            The teammates running in our own Agor instance today — each with a name, a job, and a
            memory.
          </p>
          <p className={styles.rosterStatusLine}>
            <span className={styles.rosterStatusDot} aria-hidden="true" />
            {rosterMembers.length} contacts tracked — hover or tap to scan
          </p>
        </div>
        <div className={styles.radarScope} ref={radarScopeRef}>
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
                  <span className={styles.tooltipMem}>{member.meta}</span>
                </div>
              </div>
            );
          })}
        </div>
        {/* Phone-only: the floating tooltips clip against the scope edge on
            small screens, so the active member's card renders in a fixed
            panel below the radar instead (tapping a blip focuses it, which
            drives hoveredMember). Desktop keeps the tooltips. */}
        <div
          className={
            radarInView ? `${styles.radarDetail} ${styles.radarDetailVisible}` : styles.radarDetail
          }
          aria-live="polite"
        >
          {hoveredMember !== null ? (
            <>
              <p className={styles.tooltipName}>{rosterMembers[hoveredMember].name}</p>
              <p className={styles.tooltipRole}>{rosterMembers[hoveredMember].role}</p>
              <div className={styles.tooltipMeta}>
                <span className={styles.tooltipMem}>{rosterMembers[hoveredMember].meta}</span>
              </div>
            </>
          ) : (
            <p className={styles.radarDetailHint}>Tap a teammate to scan</p>
          )}
        </div>
      </section>

      <section className={styles.finalCta} data-reveal>
        <div className={styles.ctaCard}>
          <h2>
            Give your <span className={styles.headingAccent}>AI teammates</span> a place to{' '}
            <span className={styles.headingStrong}>work</span>
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
            <h3>Product</h3>
            <Link href="/guide/boards">Boards</Link>
            <Link href="/guide/sessions">Sessions</Link>
            <Link href="/guide/teammates">Teammates</Link>
            <Link href="/guide/internal-mcp">MCP control</Link>
          </div>
          <div>
            <h3>Resources</h3>
            <Link href="/guide/getting-started">Get started</Link>
            <Link href="/guide">Documentation</Link>
            <Link href="/blog/agor-cloud">Agor Cloud</Link>
          </div>
          <div>
            <h3>Community</h3>
            <Link href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
              GitHub
            </Link>
            <Link href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">
              Discord
            </Link>
            <button
              type="button"
              className={styles.footerLinkButton}
              onClick={() => setIsBetaFormOpen(true)}
            >
              Sign up for Agor Cloud
            </button>
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
    </main>
  );
}
