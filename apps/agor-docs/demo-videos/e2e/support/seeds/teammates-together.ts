// "Raise AI teammates together": SaaSy Co. (seeds/saasy.ts) with a full
// crew of AI teammates, a dense company knowledge base, and EngBot's
// heartbeat and schedules, for the personality / integrity / capability /
// agency montage.
//
// - Ten more teammates join EngBot, DataBot and LegalBot on a "Teammates"
//   board, so the teammate pickers have a well-rounded list.
// - "SaaSy Co. Handbook" is a Knowledge namespace of ~200 interlinked pages
//   (generated below: section hubs, cross-links), so its graph is dense; a
//   few smaller namespaces fill out the namespace pickers.
// - EngBot gets its own HEARTBEAT.md and three schedules.

import type { SeedDef } from '../seeds.ts';

const USER = `- **Name:** Sam Rivera
- **What to call them:** Sam
- **Role:** Engineering manager at SaaSy Co.`;

interface Crew {
  key: string;
  displayName: string;
  emoji: string;
  description: string;
}

/** The rest of the crew (EngBot, DataBot and LegalBot come from the saasy seed). */
const CREW: Crew[] = [
  {
    key: 'opsbot',
    displayName: 'OpsBot',
    emoji: '📈',
    description: 'Operations: revenue, orders and the daily numbers.',
  },
  {
    key: 'supportbot',
    displayName: 'SupportBot',
    emoji: '🎧',
    description: 'Triages the support queue and drafts replies.',
  },
  {
    key: 'salesbot',
    displayName: 'SalesBot',
    emoji: '🎯',
    description: 'Researches accounts and preps every sales call.',
  },
  {
    key: 'financebot',
    displayName: 'FinanceBot',
    emoji: '🧮',
    description: 'Month-end close, invoices and the runway model.',
  },
  {
    key: 'peoplebot',
    displayName: 'PeopleBot',
    emoji: '🌱',
    description: 'Onboarding plans, policies and interview loops.',
  },
  {
    key: 'securitybot',
    displayName: 'SecurityBot',
    emoji: '🛡️',
    description: 'Reviews access, dependencies and SOC 2 evidence.',
  },
  {
    key: 'designbot',
    displayName: 'DesignBot',
    emoji: '🎨',
    description: 'Keeps the design system and UI copy consistent.',
  },
  {
    key: 'releasebot',
    displayName: 'ReleaseBot',
    emoji: '🚀',
    description: 'Cuts releases and writes the changelog.',
  },
  {
    key: 'researchbot',
    displayName: 'ResearchBot',
    emoji: '🔭',
    description: 'Tracks competitors and summarizes the market.',
  },
  {
    key: 'oncallbot',
    displayName: 'OnCallBot',
    emoji: '🚨',
    description: 'First responder: alerts, runbooks and incident notes.',
  },
];

const HEARTBEAT = `# HEARTBEAT.md

What EngBot does on each heartbeat, without being asked.

## Every weekday morning

- Read the SaaSy board: who is on which ticket, what moved since yesterday.
- Post a standup digest to #eng: one line per person, blockers first.

## Every afternoon

- Sweep open PRs: anything waiting on review for more than a day gets a
  nudge to its reviewer.
- PRs with failing checks: tell the author what broke.

## Every Friday

- Draft the retro notes: what shipped, what slipped, what we learned.
- File anything worth keeping in the Handbook under \`engineering/\`.

## Never

- Merge, deploy or close a ticket on my own.
- Ping anyone outside working hours.
`;

// The Handbook: section hubs, each with a set of pages that link to their
// hub, to a neighbor, and now and then across sections.
const SECTIONS: Record<string, string[]> = {
  engineering: [
    'Architecture overview',
    'Service map',
    'API conventions',
    'Error handling',
    'Database migrations',
    'Feature flags',
    'Code review guide',
    'Branching and releases',
    'Testing strategy',
    'Local dev setup',
    'Observability',
    'Logging standards',
    'Performance budgets',
    'Mobile app architecture',
    'Offline sync',
    'Route optimizer',
    'Scheduling engine',
    'Invoicing engine',
    'Tax calculation',
    'QuickBooks integration',
    'Webhooks',
    'Rate limiting',
    'Background jobs',
    'Caching',
    'Search indexing',
    'Decision: Postgres for scheduling',
    'Decision: queue-based sync',
    'Decision: React Native',
    'Tech debt register',
    'Deprecation policy',
  ],
  runbooks: [
    'On-call handbook',
    'Incident response',
    'Severity levels',
    'Postmortem template',
    'QuickBooks sync failures',
    'Payment webhook backlog',
    'Database failover',
    'Elevated API latency',
    'Mobile crash spike',
    'Stuck background jobs',
    'Certificate renewal',
    'DNS changes',
    'Restoring a backup',
    'Rotating secrets',
    'Status page updates',
    'Customer data export',
    'Rollback a release',
    'Feature flag kill switch',
    'Queue saturation',
    'Disk pressure',
  ],
  product: [
    'Product principles',
    'Roadmap 2026',
    'Personas',
    'Dispatcher persona',
    'Technician persona',
    'Owner persona',
    'Pricing and packaging',
    'Plan limits',
    'Onboarding flow',
    'Activation metrics',
    'Spec: customer time windows',
    'Spec: bulk reassign',
    'Spec: offline queue',
    'Spec: multi-tax invoices',
    'Spec: QuickBooks retry',
    'Feedback triage',
    'Beta program',
    'Release notes style',
    'Competitive landscape',
    'Win/loss notes',
  ],
  data: [
    'Metric definitions',
    'MAU',
    'Activation rate',
    'Net revenue retention',
    'Churn',
    'Warehouse overview',
    'dbt project layout',
    'Staging models',
    'Marts',
    'Data quality checks',
    'Board deck metrics',
    'Product dashboard',
    'Event tracking plan',
    'Internal accounts filter',
    'Cohort analysis',
    'Forecasting model',
    'Data access policy',
    'PII handling',
  ],
  sales: [
    'Sales playbook',
    'Ideal customer profile',
    'Discovery questions',
    'Demo script',
    'Objection handling',
    'Pricing approvals',
    'Discount policy',
    'Deal desk',
    'Mutual action plans',
    'Champion letters',
    'Plumbing vertical',
    'HVAC vertical',
    'Electrical vertical',
    'Landscaping vertical',
    'Partner program',
    'Renewals process',
    'Expansion plays',
    'Case studies',
    'Reference customers',
    'Territory plan',
  ],
  support: [
    'Support handbook',
    'Ticket priorities',
    'SLA targets',
    'Macros',
    'Escalation path',
    'Known issues',
    'Billing questions',
    'Technician app FAQ',
    'Dispatcher FAQ',
    'QuickBooks FAQ',
    'Refund policy',
    'Account deletion',
    'Data export requests',
    'Tone of voice',
    'Help center style',
    'Bug report template',
    'CSAT program',
    'Support metrics',
  ],
  legal: [
    'Legal playbook',
    'MSA template',
    'Limitation of liability',
    'Data processing addendum',
    'Security exhibit',
    'Order form terms',
    'Auto-renewal',
    'Indemnities',
    'IP ownership',
    'Confidentiality',
    'Subprocessors',
    'Privacy policy',
    'Terms of service',
    'Contract approval matrix',
    'NDA template',
    'Vendor review',
    'Trademark guidelines',
    'Open source policy',
  ],
  security: [
    'Security program',
    'SOC 2 controls',
    'Access reviews',
    'Onboarding access',
    'Offboarding access',
    'Vulnerability management',
    'Dependency updates',
    'Secrets management',
    'Encryption',
    'Backups',
    'Pen test findings',
    'Security questionnaire answers',
    'Incident disclosure',
    'Laptop policy',
    'Phishing drills',
  ],
  people: [
    'Employee handbook',
    'Values',
    'Hiring process',
    'Interview loops',
    'Engineering ladder',
    'Onboarding plan',
    'First week',
    'Time off',
    'Remote work',
    'Expenses',
    'Benefits',
    'Performance reviews',
    'Feedback culture',
    'Meeting norms',
    'Team rituals',
  ],
  finance: [
    'Finance handbook',
    'Month-end close',
    'Revenue recognition',
    'Invoicing process',
    'Collections',
    'Budget 2026',
    'Runway model',
    'Board reporting',
    'Spend approvals',
    'Vendor payments',
    'Sales tax',
    'Payroll calendar',
  ],
};

const HANDBOOK = 'saasy-handbook';
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

interface Page {
  path: string;
  title: string;
  section: string;
}

function handbookPages(): { pages: Page[]; content: Map<string, string> } {
  const pages: Page[] = [];
  const sections = Object.keys(SECTIONS);
  for (const section of sections) {
    for (const title of SECTIONS[section]) {
      pages.push({ path: `${section}/${slugify(title)}.md`, title, section });
    }
  }
  const link = (p: Page) => `[${p.title}](/kb/${HANDBOOK}/${p.path})`;
  const content = new Map<string, string>();
  // Deterministic "random" cross-links.
  let seed = 7;
  const next = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  sections.forEach((section) => {
    const inSection = pages.filter((p) => p.section === section);
    const hub = inSection[0];
    inSection.forEach((page, i) => {
      const links: Page[] = [];
      if (page !== hub) links.push(hub);
      if (i + 1 < inSection.length) links.push(inSection[i + 1]);
      if (i % 3 === 0 && i + 4 < inSection.length) links.push(inSection[i + 4]);
      if (next() < 0.35) links.push(pages[Math.floor(next() * pages.length)]);
      if (page === hub) {
        // Hubs list their section and point at the other hubs.
        links.push(...inSection.slice(1, 8));
        for (const other of sections) {
          if (other !== section) links.push(pages.find((p) => p.section === other) as Page);
        }
      }
      const unique = [...new Set(links)].filter((p) => p !== page);
      content.set(
        page.path,
        `# ${page.title}\n\nPart of the SaaSy Co. Handbook (${section}). Owned by the ${section} team.\n\n## Related\n\n${unique
          .map((p) => `- ${link(p)}`)
          .join('\n')}\n`
      );
    });
  });
  return { pages, content };
}

export const teammatesTogether: SeedDef = {
  name: 'teammates-together',
  extends: 'saasy',
  description:
    'SaaSy Co. with a crew of 13 AI teammates, a ~200-page interlinked Handbook in Knowledge, and EngBot with a HEARTBEAT.md and three schedules.',
  inputs: ['support/seeds/teammates-together.ts'],
  async run(s) {
    await s.board('crew', {
      title: 'Teammates',
      icon: '🤝',
      description: "SaaSy Co.'s AI teammates.",
      zones: {
        crew: { label: 'AI teammates', x: 0, y: 0, width: 2560, height: 1100, color: '#722ed1' },
      },
    });
    for (const [i, c] of CREW.entries()) {
      await s.teammate(c.key, {
        board: 'crew',
        zone: 'crew',
        at: { x: 30 + (i % 4) * 620, y: 70 + Math.floor(i / 4) * 300 },
        displayName: c.displayName,
        emoji: c.emoji,
        description: c.description,
        identity: `You are ${c.displayName}, SaaSy Co.'s AI teammate. ${c.description}`,
        user: USER,
      });
    }

    // EngBot's heartbeat, and the schedules that run it.
    s.commit('engbot', { 'HEARTBEAT.md': HEARTBEAT }, 'EngBot heartbeat');
    const api = await s.as('sam');
    const engbot = s.world.branch('engbot');
    const schedule = (name: string, description: string, prompt: string, cron: string) =>
      api.post('/schedules', {
        branch_id: engbot.id,
        name,
        description,
        prompt,
        cron_expression: cron,
        timezone_mode: 'local',
        timezone: process.env.AGOR_E2E_TIMEZONE ?? 'America/Los_Angeles',
        agentic_tool_config: {
          agentic_tool: 'claude-code',
          configuration_reference: '__user_default__',
        },
        mcp_server_ids: [],
        enabled: true,
        retention: 5,
        allow_concurrent_runs: false,
      });
    await schedule(
      'Standup digest',
      'One line per person, blockers first, posted to #eng.',
      'Read HEARTBEAT.md and run the weekday-morning tasks for {{branch.name}}.',
      '0 9 * * 1-5'
    );
    await schedule(
      'PR review sweep',
      'Nudge reviewers on PRs waiting more than a day.',
      'Read HEARTBEAT.md and run the afternoon PR sweep.',
      '0 14 * * 1-5'
    );
    await schedule(
      'Friday retro notes',
      'What shipped, what slipped, what we learned.',
      'Read HEARTBEAT.md and draft this week’s retro notes.',
      '0 16 * * 5'
    );

    // Knowledge: the Handbook, plus a few smaller spaces for the pickers.
    const namespace = (slug: string, display_name: string, description: string) =>
      api.post('/kb/namespaces', {
        slug,
        display_name,
        description,
        kind: 'team',
        visibility_default: 'public',
        others_can: 'read',
      });
    await namespace(
      HANDBOOK,
      'SaaSy Co. Handbook',
      'How SaaSy Co. works: engineering, product, sales, support, legal and more.'
    );
    await namespace('eng-decisions', 'Engineering decisions', 'Architecture decision records.');
    await namespace('sales-playbook', 'Sales playbook', 'Plays, pricing and objection handling.');
    await namespace('customer-research', 'Customer research', 'Interview notes and synthesis.');
    const { pages, content } = handbookPages();
    for (const page of pages) {
      await api.post('/kb/documents', {
        namespace_slug: HANDBOOK,
        path: page.path,
        title: page.title,
        kind: 'doc',
        visibility: 'public',
        status: 'published',
        content_text: content.get(page.path),
        change_summary: 'Imported from the old wiki',
      });
    }
  },
};
