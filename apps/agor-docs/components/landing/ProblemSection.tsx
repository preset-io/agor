'use client';

import { Boxes, DatabaseZap, EyeOff, type LucideIcon, Repeat, Unlink, UserX } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import styles from '../LandingPage.module.css';
import { LandingLink } from './LandingLink';
import type { LandingPageId } from './pages';

// "The problem" cards — the diagnosis before the pitch. Amber accents (see
// .problemCard in the CSS module) mark these as the warning register; the
// mint solution palette arrives at the pivot line below the grid.
// Each card links to the landing page that answers it, and the link text
// foreshadows that answer (problem on the card, solution on the link).
/** The problem words in a card title, in amber (aqua once the card's
 * solution link is hovered). */
function Key({ children }: { children: ReactNode }) {
  return <span className={styles.problemKey}>{children}</span>;
}

const problemCards: Array<{
  icon: LucideIcon;
  /** Stable React key, since the title carries markup. */
  id: string;
  title: ReactNode;
  page: LandingPageId;
  anchor: string;
  /** Link text: a hint at the answer waiting on the landing page. */
  cta: string;
  body: ReactNode;
}> = [
  {
    id: 'alone',
    icon: UserX,
    title: (
      <>
        Everyone’s figuring out AI <Key>alone</Key>
      </>
    ),
    page: 'multiplayer',
    anchor: 'learn-together',
    cta: 'Get better at AI together',
    body: (
      <>
        Each person experiments behind <strong>their own screen</strong>. Good techniques stay
        private, and the team repeats the same mistakes.
      </>
    ),
  },
  {
    id: 'track',
    icon: Boxes,
    title: (
      <>
        Too many agents to <Key>track</Key>
      </>
    ),
    page: 'command-center',
    anchor: 'zones-and-prompts',
    cta: 'Give every agent a place',
    body: (
      <>
        More agents and conversations mean more coordination. Which one is <strong>blocked</strong>?
        Which one <strong>needs you</strong>?
      </>
    ),
  },
  {
    id: 'starting-over',
    icon: Repeat,
    title: (
      <>
        <Key>Starting over</Key> every time
      </>
    ),
    page: 'teammates',
    anchor: 'memory',
    cta: 'Pick up where you left off',
    body: (
      <>
        Good context gets buried in old conversations, so every recurring task needs the{' '}
        <strong>same explanation</strong> again.
      </>
    ),
  },
  {
    id: 'one-person',
    icon: Unlink,
    title: (
      <>
        Workflows <Key>only one person</Key> can run
      </>
    ),
    page: 'teammates',
    anchor: 'shared-ownership',
    cta: 'Raise teammates together',
    body: (
      <>
        That useful PR reviewer lives in <strong>one person’s setup</strong>. Nobody else can
        improve it or take it over.
      </>
    ),
  },
  {
    id: 'scattered',
    icon: DatabaseZap,
    title: (
      <>
        Context <Key>scattered</Key> everywhere
      </>
    ),
    page: 'command-center',
    anchor: 'knowledge',
    cta: 'Keep context close',
    body: (
      <>
        Knowledge is <strong>spread</strong> across repos, docs, and DMs, so agents answer without
        your team’s <strong>actual context</strong>.
      </>
    ),
  },
  {
    id: 'habits',
    icon: EyeOff,
    title: (
      <>
        New tools, <Key>same old habits</Key>
      </>
    ),
    page: 'multiplayer',
    anchor: 'enablers',
    cta: 'Turn wins into team practice',
    body: (
      <>
        Handing out AI accounts doesn’t create <strong>shared practices</strong>. Individual wins
        never become the way the team works.
      </>
    ),
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

export function ProblemSection() {
  return (
    <section className={styles.problemSection} data-reveal data-troupe-section="problem">
      <h2 className={styles.liveStatement}>
        Don&rsquo;t let AI <span className={styles.headingAccentWarm}>silo</span> your{' '}
        <span className={styles.headingStrong}>team</span>
      </h2>
      <p className={styles.liveSub}>
        <span className={styles.headingDim}>
          We’re getting better at AI on our own, but not better together.
        </span>{' '}
        Sound <span className={styles.headingAccentWarm}>familiar</span>?
      </p>
      {/* Collision composition: slots carry the static scatter pose (rotate/
          translate/negative margins/z-index via CSS vars) plus the crash
          entrance animation, keyed off .problemSection.isVisible — the inner
          .problemCard keeps its own hover behavior. Cards deliberately lack
          data-reveal so the shared reveal transform can't fight the crash
          keyframes. */}
      <div className={styles.problemScatter}>
        {problemCards.map((card, index) => (
          <div className={styles.problemSlot} key={card.id} style={problemScatterSlots[index]}>
            <article className={`${styles.numberedCard} ${styles.problemCard}`}>
              <div className={styles.problemHead}>
                <span className={styles.problemIcon}>
                  <card.icon size={17} aria-hidden />
                </span>
                <h3>{card.title}</h3>
              </div>
              <p>{card.body}</p>
              <LandingLink
                page={card.page}
                anchor={card.anchor}
                placement="home-problem"
                className={styles.problemLink}
              >
                {card.cta}
                {/* nbsp: the arrow never wraps onto a line by itself */}
                <span aria-hidden="true">{'\u00a0'}→</span>
              </LandingLink>
            </article>
          </div>
        ))}
      </div>
    </section>
  );
}
