'use client';

import Link from 'next/link';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { trackEvent } from '../../lib/analytics';
import styles from '../LandingPage.module.css';
import { ROSTER } from './roster';

// Meet the roster: blips on the Roster Radar, from the shared roster data
// (roster.ts), which /agent-roster also lists in full.
const rosterMembers = ROSTER;

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

export function RosterSection({
  sampler = false,
  hero = false,
}: {
  sampler?: boolean;
  /** /agent-roster's hero: h1, the page's intro copy, first-screen spacing. */
  hero?: boolean;
}) {
  const Heading = hero ? 'h1' : 'h2';
  const [hoveredMember, setHoveredMember] = useState<number | null>(null);
  const [radarInView, setRadarInView] = useState(false);
  const radarScopeRef = useRef<HTMLDivElement>(null);
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
    <section
      id="roster"
      className={hero ? `${styles.rosterSection} ${styles.rosterHero}` : styles.rosterSection}
      data-reveal
      data-troupe-section="roster"
    >
      <div className={styles.rosterCopy}>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>
            {hero ? 'The Preset agent roster' : 'Meet the Preset agent team'}
          </span>
          <Heading>
            Teammates we’ve <span className={styles.headingStrong}>raised</span>{' '}
            <span className={styles.headingAccent}>together</span>
          </Heading>
        </div>
        {hero ? (
          <p className={styles.rosterBody}>
            <span className={styles.rosterLead}>
              On Preset’s internal Slack, AI teammates now outnumber the humans.
            </span>{' '}
            These are some we run on our own Agor instance, for deal desk, legal, market research,
            bug fixing, security patches, data engineering, and more. Each has a name, a job, its
            own memory, and a team of people who teach it and keep it improving. They’re examples of
            the use cases we’re tackling; your team can raise whichever teammates it needs.
          </p>
        ) : (
          <p className={styles.rosterBody}>
            A few examples from our own Agor instance today. Each has a name, a job, its own memory,
            and a team of people who teach it and keep it improving.
          </p>
        )}
        <p className={styles.rosterStatusLine}>
          <span className={styles.rosterStatusDot} aria-hidden="true" />
          <span>
            <span className={styles.hoverWord}>Hover</span>
            <span className={styles.tapWord}>Tap</span> to meet them
          </span>
        </p>
        {sampler && (
          <div className={styles.learnMore}>
            <Link
              href="/agent-roster"
              className={styles.learnMoreLink}
              onClick={() =>
                trackEvent('landing_page_click', {
                  landing_page: 'agent-roster',
                  landing_anchor: '',
                  placement: 'home-section',
                })
              }
            >
              Meet the whole roster <span aria-hidden="true">→</span>
            </Link>
          </div>
        )}
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
          // Written-up members link to their listing on /agent-roster (which
          // links on to the post); the rest are quieter and only show a card.
          return member.story ? (
            <Link
              key={member.name}
              href={`/agent-roster#${member.id}`}
              className={blipClass}
              style={radarPosition(member.r, member.a)}
              onMouseEnter={() => setHoveredMember(index)}
              onMouseLeave={() => setHoveredMember(null)}
              onFocus={() => setHoveredMember(index)}
              onBlur={() => setHoveredMember(null)}
              aria-label={`${member.name}: ${member.role}. Meet ${member.name}`}
              onClick={() =>
                trackEvent('landing_page_click', {
                  landing_page: 'agent-roster',
                  landing_anchor: member.id,
                  placement: hero ? 'agent-roster-radar' : 'home-radar',
                })
              }
            >
              <span className={styles.blipIcon}>
                <member.icon size={19} aria-hidden />
              </span>
              <span className={styles.blipName}>{member.name}</span>
            </Link>
          ) : (
            <button
              type="button"
              key={member.name}
              className={`${blipClass} ${styles.radarBlipQuiet}`}
              style={radarPosition(member.r, member.a)}
              onMouseEnter={() => setHoveredMember(index)}
              onMouseLeave={() => setHoveredMember(null)}
              onFocus={() => setHoveredMember(index)}
              onBlur={() => setHoveredMember(null)}
              aria-label={`${member.name}: ${member.role}`}
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
              {member.story ? (
                <p className={styles.tooltipStory}>
                  Click to meet them <span aria-hidden="true">{hero ? '↓' : '→'}</span>
                </p>
              ) : null}
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
            {rosterMembers[hoveredMember].story ? (
              <Link
                href={`/agent-roster#${rosterMembers[hoveredMember].id}`}
                className={styles.tooltipStory}
              >
                Meet {rosterMembers[hoveredMember].name}{' '}
                <span aria-hidden="true">{hero ? '↓' : '→'}</span>
              </Link>
            ) : null}
          </>
        ) : (
          <p className={styles.radarDetailHint}>Tap a teammate to scan</p>
        )}
      </div>
    </section>
  );
}
