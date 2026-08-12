'use client';

import {
  Activity,
  BookOpen,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Eye,
  GitBranch,
  KeyRound,
  type LucideIcon,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, PRESET_URL, presetUtm } from '../lib/links';
import { getBasePath, LOGO_MARK_PATH } from '../lib/siteMetadata';
import styles from './AgorCloudLanding.module.css';
import Aurora from './Aurora/Aurora';
import { HubSpotFormModal } from './HubSpotFormModal';
import { HubSpotMeetingModal } from './HubSpotMeetingModal';

const basePath = getBasePath();

// Link to the existing announcement (kept as the long-form companion to this
// conversion-focused page).
const ANNOUNCEMENT_HREF = '/blog/agor-cloud';

// The operational reality of self-hosting a multi-user Agor: the honest case
// for a managed offering, without disparaging the open product. Grounded in the
// Agor Cloud announcement post.
const opsBurden: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Server,
    title: 'Stateful to operate',
    body: 'A database that needs backups, migrations, and a tested recovery story for when something breaks.',
  },
  {
    icon: Boxes,
    title: 'Isolation that holds',
    body: 'Per-user, per-branch boundaries so one developer’s session, worktree, or runaway process never stomps another’s.',
  },
  {
    icon: RefreshCw,
    title: 'Always patched',
    body: 'Same-day fixes when the next CVE lands in Node, Postgres, the kernel, or any dependency in the stack.',
  },
  {
    icon: Eye,
    title: 'Eyes on everything',
    body: 'Observability across a fleet of dev environments and an audit trail your security team will actually accept.',
  },
];

// What Agor Cloud manages. Every claim maps to shipped capability in the
// agor-cloud control plane (EKS + Karpenter, per-team workspaces & roles,
// WorkOS social sign-on, BYOK, CI session genealogy).
//
// Split into two tiers: capabilityHighlights get the screenshot-carousel
// treatment below (only claims with a real, accurately-representative
// screenshot on hand — verified by actually looking at each image, not
// just its filename); capabilitySupport stays as a smaller supporting
// card row for claims that are genuinely backend/infra properties with
// nothing meaningful to screenshot (autoscaling, workspace tenancy,
// health checks).
const capabilityHighlights: Array<{
  icon: LucideIcon;
  title: string;
  body: string;
  image: string;
}> = [
  {
    icon: KeyRound,
    title: 'Bring your own keys',
    body: 'Claude, Codex, Gemini: your keys, billed by your provider. We don’t proxy your tokens, mark them up, or take a cut, so there’s no incentive to burn more of them.',
    image: '/screenshots/per-user-api-keys.png',
  },
  {
    icon: SlidersHorizontal,
    title: 'Sign-in that fits',
    body: 'Social sign-on today through a SOC 2 Type II identity provider, with enterprise SSO on the roadmap. Team roles decide who can see and do what.',
    image: '/screenshots/edit_user.png',
  },
  {
    icon: GitBranch,
    title: 'CI-ready agents',
    body: 'CI-triggered sessions appear on your board in real time, keep the context that built the branch, and stay live to resume once the job ends.',
    image: '/screenshots/subsession-codex-running.png',
  },
];

const capabilitySupport: Array<{ icon: LucideIcon; title: string; body: ReactNode }> = [
  {
    icon: Cloud,
    title: 'Fully managed, always current',
    body: 'Runs on autoscaling Kubernetes with tuned node pools and resource budgets. New releases land on Cloud after they’re validated against our own production traffic, never yours.',
  },
  {
    icon: Users,
    title: 'Segment into isolated workspaces',
    body: 'Run multiple Agor workspaces under one account and segment them by team, project, or sensitivity. Each workspace is its own tenant, with a separate database and strict boundaries between them, so you can dial isolation up exactly where it matters.',
  },
  {
    icon: Activity,
    title: 'Kept alive for you',
    body: 'Health checks, auto-recovery, and capacity management for the fleet of environments underneath your team. You build; we keep the lights on.',
  },
];

// Governance & observability: the strongest enterprise differentiation. Each
// item is grounded: audit_events, team roles + per-tenant RLS isolation, usage
// tiers/quotas, Datadog + executor accounting.
const governance: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: ScrollText,
    title: 'Audit trail',
    body: 'Session creation, prompt submissions, branch and owner changes, and admin actions, all recorded with secret-safe metadata.',
  },
  {
    icon: ShieldCheck,
    title: 'Roles & access control',
    body: 'Team roles (owner, admin, member) decide who can see and do what. Access is scoped per workspace and every privileged change is auditable, so the right people reach the right work and nothing more.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Usage tiers & quotas',
    body: 'Per-team tiers and workspace quotas keep usage visible and bounded, so a busy team can’t surprise the rest of the org.',
  },
  {
    icon: Activity,
    title: 'Real observability',
    body: 'Structured logs, metrics, and executor-level accounting via Datadog, the same signals we use to run it, surfaced for your team too.',
  },
];

// Deployment models. (a) is live in the private beta; (b) MPC is architected
// and offered as a conversation; (c) full on-prem/BYOC is a later enterprise
// tier. Maturity is signalled honestly via the badge.
const deployments: Array<{
  badge: string;
  badgeClass: string;
  title: string;
  body: string;
  featured?: boolean;
}> = [
  {
    badge: 'Available in beta',
    badgeClass: styles.badgeNow,
    title: 'Agor Cloud (hosted)',
    body: 'A managed, single-tenant Agor instance on our infrastructure. Up in minutes, always on the latest secured release, hardened to sit safely on the public internet.',
    featured: true,
  },
  {
    badge: 'In your AWS',
    badgeClass: styles.badgeAws,
    title: 'Managed private cloud',
    body: 'We deploy and operate Agor inside your own AWS account, so data and compute stay in your tenancy, with private network access to your VPC. Talk to us about fit.',
  },
  {
    badge: 'Enterprise',
    badgeClass: styles.badgeEnterprise,
    title: 'Private cloud / on-prem',
    body: 'For organizations that need to operate the whole stack themselves. A larger engagement we scope with enterprise teams, so reach out to start the conversation.',
  },
];

// Security posture. Worded deliberately: SOC 2 is *in progress*, never claimed
// complete; pen testing / review framed as part of how the service is operated.
const security: Array<{ title: string; body: string }> = [
  {
    title: 'Hardened by default',
    body: 'The open-source flags that widen attack surface (shared dev boxes, broad bypass modes) are off in Cloud. We know which knobs belong in which position because we run it ourselves.',
  },
  {
    title: 'Unix-level isolation',
    body: 'Sessions, worktrees, and environments run as distinct Unix users, with filesystem permissions enforcing the boundaries between users, branches, and agents as defense-in-depth.',
  },
  {
    title: 'Independently reviewed',
    body: 'Built against a documented threat model, with independent security review and penetration testing as part of how the service is operated.',
  },
  {
    title: 'SOC 2 Type II in progress',
    body: 'Our SOC 2 Type II audit is underway, and identity is handled by a SOC 2 Type II provider. Your AI keys stay yours and never route through us.',
  },
];

export function AgorCloudLanding() {
  const shellRef = useRef<HTMLElement>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDemoOpen, setIsDemoOpen] = useState(false);
  // Which CTA opened the (single, shared) beta form, stamped into the form's
  // hidden source_page field for attribution, matching the site convention.
  const [formSource, setFormSource] = useState('cloud-page-hero');

  const openForm = (source: string) => {
    setFormSource(source);
    setIsFormOpen(true);
  };

  const [activeCapability, setActiveCapability] = useState(0);

  // Reveal-on-scroll with a safety net. The entrance animation is a
  // progressive enhancement; content must NEVER be stranded invisible. The
  // reveal fires as sections scroll in (like LandingPage), but a timeout
  // backstop reveals anything still hidden, covering contexts where the
  // observer never gets a scroll event (embedded iframes / board previews
  // whose inner window doesn't scroll, JS-throttled tabs, or fast scrolls the
  // observer misses). Reduced motion shows everything immediately.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const items = Array.from(shell.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!items.length) {
      return;
    }
    const revealAll = () => {
      items.forEach((item) => {
        item.classList.add(styles.isVisible);
      });
    };
    if (
      typeof IntersectionObserver === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      revealAll();
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
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    items.forEach((item) => {
      observer.observe(item);
    });
    // Backstop: if the reader hasn't triggered reveals through scrolling,
    // reveal everything so nothing stays blank. Below-fold sections simply
    // appear without the entrance animation, a fine trade for never showing
    // an empty page.
    const fallback = window.setTimeout(revealAll, 1400);
    return () => {
      observer.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);

  return (
    // <main> with Nextra's skip-nav id; the "full" layout provides no main
    // landmark of its own, so this is the page's only one.
    <main ref={shellRef} id="nextra-skip-nav" className={styles.landingShell}>
      {/* --- Hero --- */}
      <section className={styles.hero}>
        {/* Same looping product-demo backdrop as the homepage hero, dimmed
            further behind the glass card so the copy stays the loudest
            thing on screen. Falls back to the poster frame under
            prefers-reduced-motion (CSS hides the video element). */}
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
        <div className={styles.heroGlow} aria-hidden="true" />
        <div className={styles.heroInner} data-reveal>
          <p className={styles.heroBadge}>
            <span className={styles.heroBadgeDot} aria-hidden="true" />
            Agor Cloud · Private beta
          </p>
          <h1>
            Fully managed Agor for your <span className={styles.headingStrong}>whole team</span>
          </h1>
          <p className={styles.heroSub}>
            Agor is open, and yours to run. Agor Cloud is for teams who’d rather not. We operate a
            hardened, always-current Agor for you, with scaling, isolation, governance, and
            observability handled, so your team can focus on the work, not the platform underneath
            it.
          </p>
          <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => openForm('cloud-page-hero')}
            >
              Request an invite
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setIsDemoOpen(true)}
            >
              Book a demo
            </button>
            <Link href={ANNOUNCEMENT_HREF} className={styles.secondaryButton}>
              <BookOpen size={17} aria-hidden="true" />
              Read the announcement
            </Link>
          </div>
          <p className={styles.metaLine}>Built and operated by the team behind Preset Cloud.</p>
        </div>
      </section>

      {/* --- Why teams graduate from self-hosting --- */}
      <section className={styles.section} data-reveal>
        {/* Same mint Aurora shader used as the homepage's showcase-section
            divider — a bit of motion and texture at the seam instead of a
            hard cut between the hero and the next flat section. */}
        <div className={styles.sectionDivider} aria-hidden="true">
          <Aurora
            colorStops={['#2e9a92', '#34e6c4', '#7ad9ff']}
            amplitude={0.9}
            blend={1}
            speed={0.6}
          />
        </div>
        <div className={styles.sectionHead}>
          <span className={styles.eyebrow}>Open source, minus the ops</span>
          <h2>
            You can run Agor yourself.
            <br />
            Most teams <span className={styles.headingStrong}>shouldn’t have to</span>.
          </h2>
          <p className={styles.lead}>
            Agor is source-available under BSL 1.1, and running it in production yourself is
            permitted and supported. But operating it well for a whole team becomes its own
            full-time job:
          </p>
        </div>
        <div className={`${styles.grid} ${styles.grid2}`}>
          {opsBurden.map((item) => (
            <article className={styles.card} key={item.title}>
              <span className={styles.cardIcon}>
                <item.icon size={20} aria-hidden="true" />
              </span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
        <p className={styles.pivot}>
          Agor Cloud is us doing that once,{' '}
          <span className={styles.headingAccent}>well, for everyone</span>.
        </p>
      </section>

      {/* --- Capabilities --- */}
      <section className={styles.section} data-reveal>
        <div className={styles.sectionHead}>
          <span className={styles.eyebrow}>Fully managed</span>
          <h2>
            Everything running, <span className={styles.headingAccent}>nothing to babysit</span>
          </h2>
          <p className={styles.lead}>
            The same platform you know from the open project, operated for you with the rigor Preset
            brings to Preset Cloud.
          </p>
        </div>
        {/* Screenshot carousel for the three capabilities with something
            real to show (same tab-pill + frame grammar as the homepage's
            surface explorer); tap the shot or use the arrows to advance. */}
        <div className={styles.capabilityTabs}>
          {capabilityHighlights.map((item, index) => (
            <button
              type="button"
              key={item.title}
              className={
                index === activeCapability
                  ? `${styles.capabilityTab} ${styles.capabilityTabActive}`
                  : styles.capabilityTab
              }
              aria-pressed={index === activeCapability}
              onClick={() => setActiveCapability(index)}
            >
              <item.icon size={16} aria-hidden="true" />
              {item.title}
            </button>
          ))}
        </div>
        <div className={styles.capabilityFrame}>
          <div className={styles.capabilityViewport}>
            <div
              className={styles.capabilityTrack}
              style={{
                width: `${capabilityHighlights.length * 100}%`,
                transform: `translateX(-${activeCapability * (100 / capabilityHighlights.length)}%)`,
              }}
            >
              {capabilityHighlights.map((item, index) => (
                <div
                  className={styles.capabilitySlide}
                  key={item.title}
                  style={{ width: `${100 / capabilityHighlights.length}%` }}
                >
                  <button
                    type="button"
                    className={styles.capabilityShotButton}
                    aria-label="Next capability"
                    onClick={() => setActiveCapability((index + 1) % capabilityHighlights.length)}
                  >
                    {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
                    <img
                      className={styles.capabilityShot}
                      src={item.image}
                      alt={`Screenshot of ${item.title} in Agor`}
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
            className={`${styles.capabilityArrow} ${styles.capabilityArrowLeft}`}
            onClick={() =>
              setActiveCapability(
                (activeCapability + capabilityHighlights.length - 1) % capabilityHighlights.length
              )
            }
          >
            <ChevronLeft size={20} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next capability"
            className={`${styles.capabilityArrow} ${styles.capabilityArrowRight}`}
            onClick={() =>
              setActiveCapability((activeCapability + 1) % capabilityHighlights.length)
            }
          >
            <ChevronRight size={20} aria-hidden />
          </button>
        </div>
        <div className={styles.capabilityInfo}>
          <h3>{capabilityHighlights[activeCapability].title}</h3>
          <p>{capabilityHighlights[activeCapability].body}</p>
        </div>
        {/* The rest — genuinely backend/infra properties with nothing real
            to screenshot (autoscaling, workspace tenancy, health checks) —
            stay as a smaller supporting row underneath. */}
        <div className={`${styles.grid} ${styles.grid3} ${styles.supportGrid}`}>
          {capabilitySupport.map((item) => (
            <article className={styles.card} key={item.title}>
              <span className={styles.cardIcon}>
                <item.icon size={20} aria-hidden="true" />
              </span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* --- Governance & observability (differentiator) --- */}
      <div className={styles.band}>
        <section className={styles.section} data-reveal>
          <div className={styles.sectionHead}>
            <span className={styles.eyebrow}>Governance &amp; observability</span>
            <h2>
              See everything. <span className={styles.headingStrong}>Prove anything</span>.
            </h2>
            <p className={styles.lead}>
              When Agor becomes part of how your team ships, you need to see what’s happening in it,
              and so does whoever runs your next security review.
            </p>
          </div>
          <div className={`${styles.grid} ${styles.grid2}`}>
            {governance.map((item) => (
              <article className={styles.card} key={item.title}>
                <span className={styles.cardIcon}>
                  <item.icon size={20} aria-hidden="true" />
                </span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>
      </div>

      {/* --- Deployment options --- */}
      <section className={styles.section} data-reveal>
        <div className={styles.sectionHead}>
          <span className={styles.eyebrow}>Deploy your way</span>
          <h2>
            Three ways to <span className={styles.headingAccent}>run it</span>
          </h2>
          <p className={styles.lead}>
            Start on our infrastructure and move closer to your own as your requirements grow. The
            same Agor, in the topology your security team needs.
          </p>
        </div>
        <div className={styles.deployGrid}>
          {deployments.map((item) => (
            <article
              className={
                item.featured
                  ? `${styles.deployCard} ${styles.deployCardFeatured}`
                  : styles.deployCard
              }
              key={item.title}
            >
              <span className={`${styles.badge} ${item.badgeClass}`}>{item.badge}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
        <p className={styles.deployNote}>
          Network topology is a conversation, not a checkbox. Tell us what your security team needs
          and we’ll work out the shape.
        </p>
      </section>

      {/* --- Security & trust --- */}
      <div className={styles.band}>
        <section className={styles.section} data-reveal>
          <div className={styles.trustLayout}>
            <div className={styles.trustText}>
              <div className={styles.sectionHead}>
                <span className={styles.eyebrow}>Security</span>
                <h2>
                  Hardened for the <span className={styles.headingStrong}>public internet</span>
                </h2>
                <p className={styles.lead}>
                  Some of Agor’s capabilities are great inside a trusted network and risky on the
                  open internet. Cloud is built the other way around, so your team can use it from
                  anywhere, mobile included, with no VPN gymnastics.
                </p>
              </div>
              <ul className={styles.trustList}>
                {security.map((item) => (
                  <li className={styles.trustItem} key={item.title}>
                    <span className={styles.trustCheck} aria-hidden="true">
                      <ShieldCheck size={15} />
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <span>{item.body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {/* A real security-review branch: sub-sessions fanned out across
                the exact domains claimed on the left (RBAC, secrets, Unix
                isolation, supply chain, ...), not a stock illustration. */}
            <div className={styles.trustShotFrame}>
              {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
              <img
                className={styles.trustShot}
                src="/screenshots/security-review-fanout.png"
                alt="A security-review branch in Agor, with sub-sessions fanned out across RBAC, secrets management, Unix isolation, dependency supply chain, and more"
                loading="lazy"
              />
            </div>
          </div>
        </section>
      </div>

      {/* --- Who operates it --- */}
      <section className={styles.section} data-reveal>
        <div className={styles.operator}>
          <div>
            <span className={styles.eyebrow}>Who runs it</span>
            <h2>
              Operated by the team behind <span className={styles.headingStrong}>Preset Cloud</span>
            </h2>
            <p>
              Preset runs Preset Cloud, a managed Apache Superset service used by thousands of
              teams. Agor Cloud is operated with the same on-call rigor, by the people building
              Agor. You get hands-on onboarding, a direct line for feedback, and features
              prioritized around what early teams actually need.
            </p>
          </div>
          <div className={styles.operatorStats}>
            <div className={styles.stat}>
              <span className={styles.statValue}>Trust the makers</span>
              <span className={styles.statLabel}>
                The team that wrote Agor keeps it running, and they know which knobs matter.
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>Same-day patching</span>
              <span className={styles.statLabel}>
                When a zero-day lands, the fix ships that day. You don’t track changelogs.
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>No on-call for you</span>
              <span className={styles.statLabel}>
                We’re on-call for Agor, so your team stays on-call for your product.
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>Feedback loop</span>
              <span className={styles.statLabel}>
                A direct channel to the builders. Feature requests welcome.
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* --- Final CTA --- */}
      <section className={`${styles.section} ${styles.finalCta}`} data-reveal>
        <div className={styles.sectionDivider} aria-hidden="true">
          <Aurora
            colorStops={['#2e9a92', '#34e6c4', '#7ad9ff']}
            amplitude={0.9}
            blend={1}
            speed={0.6}
          />
        </div>
        <div className={styles.ctaCard}>
          <h2>
            Bring your team to <span className={styles.headingAccent}>Agor Cloud</span>
          </h2>
          <p>
            We’re onboarding teams into the private beta now. Tell us about your team and use case,
            and we’ll take it from there: a quick fit call, then you’re set up in minutes.
          </p>
          <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => openForm('cloud-page-final')}
            >
              Request an invite
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setIsDemoOpen(true)}
            >
              Book a demo
            </button>
            <Link href={ANNOUNCEMENT_HREF} className={styles.secondaryButton}>
              Read the announcement
            </Link>
          </div>
        </div>
      </section>

      {/* --- Footer --- */}
      <footer className={styles.footer} data-reveal>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            {/* Decorative: the adjacent wordmark already names the product. */}
            {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
            <img src={`${basePath}${LOGO_MARK_PATH}`} alt="" width="40" height="40" />
            <div>
              <strong>Agor Cloud</strong>
              <p>Fully managed Agor for teams.</p>
            </div>
          </div>
          <div className={styles.footerLinks}>
            <Link href={ANNOUNCEMENT_HREF} className={styles.footerLink}>
              Announcement
            </Link>
            <Link href="/guide/getting-started" className={styles.footerLink}>
              Self-host
            </Link>
            <Link
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.footerLink}
            >
              GitHub
            </Link>
            <Link
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.footerLink}
            >
              Discord
            </Link>
            <Link
              href={`${PRESET_URL}${presetUtm('agor-cloud-footer')}`}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.footerLink}
            >
              Preset
            </Link>
            <button
              type="button"
              className={styles.footerLink}
              onClick={() => openForm('cloud-page-footer')}
            >
              Request an invite
            </button>
          </div>
        </div>
      </footer>

      <HubSpotFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        title="Request an Agor Cloud invite"
        sourceCta={formSource}
      />
      <HubSpotMeetingModal isOpen={isDemoOpen} onClose={() => setIsDemoOpen(false)} />
    </main>
  );
}
