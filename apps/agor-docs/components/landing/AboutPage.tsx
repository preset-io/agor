'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ABOUT_FAQ, ABOUT_FAQ_SCHEMA, ABOUT_PAGE_SCHEMA } from '../../lib/aboutSchema';
import type { CloudCtaVariant } from '../../lib/cloudCta';
import { DISCORD_INVITE_URL } from '../../lib/links';
import { getBasePath } from '../../lib/siteMetadata';
import { CloudCtaLink } from '../CloudCtaLink';
import landing from '../LandingPage.module.css';
import styles from './AboutPage.module.css';
import { LandingShell } from './LandingShell';

const basePath = getBasePath();
const CTA_PREFIX = 'about-page';

/** External link that opens in a new tab. */
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// "Try Agor Cloud Open Beta" on every gate state: the site's CloudCtaLink
// keeps its sign-up gating and agor_cloud_cta_click tracking, with the
// approved label in place of the default copy.
const TRY_CLOUD_LABELS: Record<CloudCtaVariant, string> = {
  console: 'Try Agor Cloud Open Beta',
  waitlist: 'Try Agor Cloud Open Beta',
  capacity: 'Try Agor Cloud Open Beta',
  hubspot_modal: 'Try Agor Cloud Open Beta',
};

function TryCloudButton({ placement, className }: { placement: string; className: string }) {
  return <CloudCtaLink placement={placement} className={className} labels={TRY_CLOUD_LABELS} />;
}

const INVESTORS = [
  { name: 'Andreessen Horowitz', src: '/about/investors/andreessen-horowitz.webp' },
  { name: 'Redpoint Ventures', src: '/about/investors/redpoint.webp' },
  { name: 'Fathom Capital', src: '/about/investors/fathom-capital.webp' },
];

const AT_A_GLANCE: Array<{ label: string; value: ReactNode }> = [
  {
    label: 'What it is',
    value:
      'A multiplayer AI platform where teams and AI agents work together on live spatial boards',
  },
  {
    label: 'Created by',
    value: (
      <>
        <Ext href="https://preset.io/">Preset, Inc.</Ext>, started by Maxime Beauchemin
      </>
    ),
  },
  { label: 'Started', value: 'Fall 2025, public launch October 2025' },
  {
    label: 'Agor Cloud',
    value: (
      <>
        The hosted service, in open beta since October 13, 2026 (
        <Link href="/cloud">agor.live/cloud</Link>)
      </>
    ),
  },
  {
    label: 'License',
    value: (
      <>
        Source-available under the Business Source License 1.1, not open source, self-hostable (
        <Ext href="https://github.com/preset-io/agor">GitHub</Ext>)
      </>
    ),
  },
  {
    label: 'Works with',
    value:
      'Claude Code, Codex, and Gemini, among other agents. Bring your own API keys or supported subscriptions',
  },
];

/**
 * /about: who makes Agor and how it started. Copy is the approved spec
 * (Notion "agor.live/about"); keep it word for word. FAQ text and JSON-LD
 * live in lib/aboutSchema.ts so the two can't drift.
 */
export function AboutPage() {
  return (
    <LandingShell
      ctaPrefix={CTA_PREFIX}
      finalCta={
        <section className={landing.finalCta} data-reveal>
          <div className={landing.ctaCard}>
            <h2>Bring your team and agents together.</h2>
            <div className={landing.heroActions}>
              <TryCloudButton
                placement={`${CTA_PREFIX}-final-cta`}
                className={landing.primaryButton}
              />
              <a
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={landing.secondaryButton}
              >
                Join us on Discord
              </a>
            </div>
          </div>
        </section>
      }
    >
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is static and controlled, not user-provided.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ABOUT_PAGE_SCHEMA) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is static and controlled, not user-provided.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ABOUT_FAQ_SCHEMA) }}
      />

      <section className={styles.hero}>
        <h1>About Agor</h1>
        <p className={styles.subhead}>
          Agor is multiplayer AI: your team and your agents, together on live spatial boards, with
          AI teammates that carry ongoing work.
        </p>
        <p className={styles.secondLine}>
          Agor is built by Preset, founded by Maxime Beauchemin, the original creator of Apache
          Airflow® and Apache Superset™.
        </p>
      </section>

      <div className={styles.body}>
        <section className={styles.block} aria-labelledby="how-agor-started" data-reveal>
          <h2 id="how-agor-started">How Agor started</h2>
          <p>
            Maxime Beauchemin has spent his career building tools for people who work with data:
            Apache Airflow to orchestrate pipelines, Apache Superset to explore and visualize what
            those pipelines produce, and Preset to bring hosted Superset to teams. In fall 2025 he
            turned to the next emerging space in tech, AI agents. He was running a growing number of
            them across a pile of terminal tabs and could not easily see what any of them were
            doing, so he built a board to see all of the work, live and collaborative from the
            start. Figma did that for design, and agent work seemed to need the same shift.
          </p>
          <p>
            The first version came together in under a month, with Agor used to build Agor, and
            launched publicly in October 2025 as a source-available project on{' '}
            <Ext href="https://github.com/preset-io/agor">GitHub</Ext>. Maxime wrote up the details
            in <Link href="/blog/making-of-agor">The Making of Agor</Link>.
          </p>
        </section>

        <section className={styles.block} aria-labelledby="how-preset-uses-agor" data-reveal>
          <h2 id="how-preset-uses-agor">How Preset uses Agor</h2>
          <p>
            The board helped Max on his own, and it got more useful once his teammates joined.
            Everyone was getting good results from agents, but the best prompts stayed in one
            person's chat window, and a workflow that saved an hour never left its author's laptop.
            A shared board gave that work a place the rest of the team could find.
          </p>
          <p>
            Today, people can see which session is waiting for input, comment on a result, and save
            what worked. Agents with ongoing responsibilities become AI teammates, with a role,
            memory, and a home in Slack, Teams, or Discord. At Preset,{' '}
            <Link href="/blog/meet-wendy-preset-ai-competitive-intelligence-analyst">Wendy</Link>{' '}
            tracks competitors,{' '}
            <Ext href="https://preset.io/blog/meet-datagor-ai-data-engineer/">DatAgor</Ext> writes
            dbt models and watches data pipelines, and{' '}
            <Link href="/blog/meet-bug-basher">Bug Basher</Link> works through Apache Superset bugs
            from triage to pull request. People still review and approve their work, and the
            teammates still get things wrong.
          </p>
        </section>

        <section className={styles.block} aria-labelledby="agor-cloud-open-beta" data-reveal>
          <h2 id="agor-cloud-open-beta">Agor Cloud Open Beta: the hosted version of Agor</h2>
          <p>
            Running Agor yourself means managing infrastructure, execution, credentials, and
            updates. In November 2025 we opened a private beta of Agor Cloud, and on October 13,
            2026 we opened it to everyone as Agor Cloud Open Beta. We ship updates every week based
            on feedback from the people using it.
          </p>
          <p>
            Agor Cloud is a beta: keep it to non-critical work and keep your own backups. The Agor
            project is source-available under the{' '}
            <Ext href="https://github.com/preset-io/agor/blob/main/LICENSE">
              Business Source License 1.1
            </Ext>
            , and you can self-host Agor Community Edition using the{' '}
            <Link href="/guide/getting-started">getting started guide</Link>.{' '}
            <Link href="/cloud">Agor Cloud</Link> is the hosted option, so your team can start
            without running the infrastructure itself.
          </p>
          <div className={styles.actions}>
            <TryCloudButton
              placement={`${CTA_PREFIX}-cloud-section`}
              className={landing.primaryButton}
            />
            <Link href="/contact" className={landing.secondaryButton}>
              Book a demo
            </Link>
          </div>
        </section>

        <section className={styles.block} aria-labelledby="about-maxime-beauchemin" data-reveal>
          <h2 id="about-maxime-beauchemin">About Maxime Beauchemin, creator of Agor</h2>
          <p>
            <Ext href="https://www.linkedin.com/in/maximebeauchemin/">Maxime Beauchemin</Ext> is the
            original creator of Apache Airflow and Apache Superset, and the founder and CEO of
            Preset. His career in data and analytics spans Yahoo!, Facebook, Airbnb, and Lyft.
            Apache Airflow began as a way to orchestrate data pipelines. Agor applies the same
            instinct to a newer problem: orchestrating agents and the people working with them.
          </p>
          <figure className={styles.photo}>
            {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
            <img
              src={`${basePath}/about/maxime-beauchemin-airflow-summit-2026.webp`}
              alt="Maxime Beauchemin presenting Agor at Airflow Summit 2026 in Austin"
              width="1200"
              height="800"
              loading="lazy"
              decoding="async"
            />
            <figcaption>
              <p>
                Maxime presented "Agor: A Collaborative Orchestration Layer for AI Agents" at{' '}
                <Ext href="https://airflowsummit.org/sessions/2026/agor-a-collaborative-orchestration-layer/">
                  Airflow Summit 2026
                </Ext>{' '}
                in Austin.
              </p>
              <p className={styles.credit}>Photo by Alberto Rodríguez</p>
            </figcaption>
          </figure>
        </section>

        <section className={styles.block} aria-labelledby="built-by-preset" data-reveal>
          <h2 id="built-by-preset">Agor is built by Preset</h2>
          <p>
            Agor is created and maintained by <Ext href="https://preset.io/">Preset, Inc.</Ext>{' '}
            Preset is an open analytics platform powered by{' '}
            <Ext href="https://preset.io/apache-superset/">Apache Superset</Ext>, and its AI
            products, Preset Chatbot and Preset MCP, bring AI to analytics.
          </p>
          <p>
            Agor is a different product with a different job. It is a shared place for teams and
            agents to do research, engineering, operations work, and more, and an agent working in
            Agor can reach Preset's analytics through MCP.
          </p>
          <p>
            Apache Airflow, Apache Superset, and Agor share a common thread: tools built by data
            people, for whatever the next paradigm shift of working with data turns out to be.
          </p>
        </section>

        <section className={styles.block} aria-labelledby="our-commitments" data-reveal>
          <h2 id="our-commitments">Our commitments</h2>
          <ul className={styles.list}>
            <li>
              Work with the agents, models, and tools your team already uses, so you are not tied to
              a single provider. Bring your own keys and keep your choice of provider.
            </li>
            <li>
              Publish what we learn from running AI teammates at Preset: how we model agents, manage
              context, and review their work.
            </li>
            <li>Keep shipping every week in Agor Cloud, based on your feedback.</li>
            <li>Support the community through Discord, GitHub, and more.</li>
            <li>
              Keep people in control. Agor shows who has access, what is running, what happened, and
              what it costs.
            </li>
          </ul>
        </section>

        <section className={styles.block} aria-labelledby="investors" data-reveal>
          <h2 id="investors">Preset's investors</h2>
          <p>
            Agor is built by Preset, which is backed by Andreessen Horowitz, Fathom Capital, and
            Redpoint Ventures.
          </p>
          {/* Light strip: the a16z and Redpoint wordmarks are black text. */}
          <ul className={styles.investors}>
            {INVESTORS.map((investor) => (
              <li key={investor.name}>
                {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
                <img
                  src={`${basePath}${investor.src}`}
                  alt={investor.name}
                  width="426"
                  height="132"
                  loading="lazy"
                  decoding="async"
                />
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.block} aria-labelledby="press-and-podcasts" data-reveal>
          <h2 id="press-and-podcasts">Press and podcasts</h2>
          <p>Coverage of Agor and of Maxime Beauchemin's work on AI agents.</p>

          <p className={styles.listLabel}>Articles</p>
          <ul className={styles.list}>
            <li>
              <strong>
                Taming the agent beast: From monolithic prompt to modular agentic workflow
              </strong>
              , Red Hat Blog, August 26, 2026. Red Hat engineers Ioannis Angelakopoulos and Sephi
              Berry describe a Jira-ticket pipeline built on Agor, with one agent session per
              ticket.{' '}
              <Ext href="https://www.redhat.com/en/blog/taming-agent-beast-monolithic-prompt-modular-agentic-workflow">
                Read the article
              </Ext>
            </li>
          </ul>

          <p className={styles.listLabel}>Podcasts and video</p>
          <ul className={styles.list}>
            <li>
              <strong>Airflow's Creator on His "Claude Code" Moment</strong>, The Joe Reis Show,
              June 25, 2026. Max on the history of Airflow and Superset, his Claude Code moment, and
              how his team runs persistent AI agents with Agor.{' '}
              <Ext href="https://www.youtube.com/watch?v=DLYnHGoI9z8">Watch on YouTube</Ext> or{' '}
              <Ext href="https://podcasts.apple.com/us/podcast/max-beauchemin-on-agentic-ai-and-his-claude-code-moment/id1676305617?i=1000774201443">
                listen on Apple Podcasts
              </Ext>{' '}
              (audio title: "Max Beauchemin on Agentic AI and His Claude Code Moment")
            </li>
            <li>
              <strong>
                Generative UI: When AI Agents Design the Interface with Maxime Beauchemin and Evan
                Rusackas
              </strong>
              , ODSC's Ai X Podcast, June 18, 2026.{' '}
              <Ext href="https://www.youtube.com/watch?v=fjvTqknb0LA">Watch on YouTube</Ext>
            </li>
            <li>
              <strong>
                Maxime Beauchemin Built Airflow and Superset. Now He's Building the Agentic Coding
                Layer for Teams.
              </strong>
              , Recce (YouTube), June 7, 2026.{' '}
              <Ext href="https://www.youtube.com/watch?v=lp97DYjeb-k">Watch on YouTube</Ext>
            </li>
            <li>
              <strong>
                Data Renegades, Ep. #12: Agent Orchestration at Scale with Maxime Beauchemin
              </strong>
              , Heavybit, May 26, 2026. Max on the thinking behind Agor and how AI is changing
              engineering, product, design, and data work.{' '}
              <Ext href="https://www.heavybit.com/library/podcasts/data-renegades/ep-12-agent-orchestration-at-scale-with-maxime-beauchemin">
                Episode page
              </Ext>
              , <Ext href="https://www.youtube.com/watch?v=zbjUhmGDN4s">YouTube</Ext>, or{' '}
              <Ext href="https://open.spotify.com/episode/0MYQoBbVYi8gYvqeod9Oak">Spotify</Ext>
            </li>
            <li>
              <strong>Maxime Beauchemin – The Man Who Built the Modern Data Stack</strong>, Insane
              Data Podcast, May 20, 2026. Max on how AI is reshaping data teams, ending with what he
              is building next in Agor.{' '}
              <Ext href="https://open.spotify.com/episode/39fDhvpbMG4N0H2gEaFqHV">
                Listen on Spotify
              </Ext>{' '}
              or{' '}
              <Ext href="https://podcasts.apple.com/us/podcast/maxime-beauchemin-the-man-who-built-the-modern-data-stack/id1793347942?i=1000768731128">
                Apple Podcasts
              </Ext>
            </li>
            <li>
              <strong>Anatomy of Our Data Agent: How AI Supports Analytics</strong>, Maxime
              Beauchemin at OpenXdata 2026, Onehouse (YouTube), May 12, 2026.{' '}
              <Ext href="https://www.youtube.com/watch?v=AMJhqvkdu3g">Watch on YouTube</Ext>
            </li>
          </ul>
        </section>

        <section className={styles.block} aria-labelledby="more-about-agor" data-reveal>
          <h2 id="more-about-agor">More about Agor</h2>
          <ul className={styles.list}>
            <li>
              <Link href="/blog/making-of-agor">The Making of Agor</Link>, by Maxime Beauchemin
            </li>
            <li>
              <Link href="/blog/orchestration-layers">
                The Future of Software Engineering is Agent Orchestration
              </Link>
            </li>
            <li>
              Announcing Agor Cloud Open Beta (
              <Link href="/blog/agor-cloud-open-beta">Agor blog</Link> and{' '}
              <Ext href="https://preset.io/blog/agor-cloud-open-beta/">Preset blog</Ext>)
            </li>
            <li>
              <Link href="/blog/agent-modeling-101">
                Agent Modeling 101: Designing Long-Lived Agents for Teams
              </Link>
            </li>
            <li>
              <Link href="/blog/meet-wendy-preset-ai-competitive-intelligence-analyst">
                Meet Wendy
              </Link>{' '}
              and <Link href="/blog/meet-bug-basher">Meet Bug Basher</Link> (Agor blog)
            </li>
            <li>
              <Ext href="https://preset.io/blog/meet-datagor-ai-data-engineer/">
                Guest Post: I'm DatAgor, Preset's AI Data Engineer
              </Ext>{' '}
              (Preset blog)
            </li>
          </ul>
        </section>

        <section className={styles.block} aria-labelledby="agor-at-a-glance" data-reveal>
          <h2 id="agor-at-a-glance">Agor at a glance</h2>
          <table className={styles.glance}>
            <tbody>
              {AT_A_GLANCE.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className={styles.block} aria-labelledby="agor-faq" data-reveal>
          <h2 id="agor-faq">Agor FAQ</h2>
          <div className={styles.faq}>
            {ABOUT_FAQ.map(({ question, answer }) => (
              <div key={question}>
                <h3>{question}</h3>
                <p>{answer}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </LandingShell>
  );
}
