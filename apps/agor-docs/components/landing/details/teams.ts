import { GITHUB_REPO_URL } from '../../../lib/links';
import type { LandingDetail } from './types';

/*
 * Copy for the /teams campaign page (TeamsCampaignLanding.tsx), a paid-search
 * landing page for Agor Cloud. It is noindex and nothing on the site links to
 * it, so it is deliberately not a LandingPageId: no hub button, no "Explore
 * more of Agor" entry, no footer link. Keep claims to what is here and
 * approved: no pricing, certifications, customer names, or metrics.
 */

export const teamsHero = {
  headline: 'Your best AI habits live in {one person’s head}',
  subhead: 'Agor turns them into AI teammates the whole team can run in Slack.',
  eyebrow: 'Agor Cloud is in open beta.',
};

export const teamsProblem: LandingDetail = {
  id: 'problem',
  navLabel: 'The problem',
  title: 'Everyone has their own AI tricks. {Nobody else gets them.}',
  body: [
    'One person on your team has a prompt that writes a clean weekly report. Another has a routine for triaging customer emails. A third gets a first draft of a contract summary in two minutes. All of it sits in private chats and personal notes.',
  ],
  points: [
    {
      title: 'When that person is out, the shortcut is out.',
      body: 'The team goes back to doing it by hand.',
    },
    {
      title: 'New hires start from zero.',
      body: 'Nobody can hand them what already works.',
    },
    {
      title: 'The same workflow gets rebuilt again and again.',
      body: 'Five people, five slightly different prompts, five different results.',
    },
    {
      title: 'No one can say what the AI actually did.',
      body: 'The work, the output and the spend are spread across personal accounts.',
    },
  ],
};

export const teamsSolution: LandingDetail = {
  id: 'solution',
  navLabel: 'The solution',
  title: 'Agor turns one person’s AI shortcuts into [teammates the whole team can run]',
  body: [],
  points: [
    {
      title: 'Build it once.',
      body: 'Capture a workflow as an AI teammate with its own memory, skills and knowledge, including shared Knowledge your team can read and build on, within permissions.',
    },
    {
      title: 'Run it in Slack.',
      body: 'Your team asks the teammate for help where they already work, the same way they would ask a colleague.',
    },
    {
      title: 'Improve it for everyone.',
      body: 'Fix a step once and every person who uses the teammate gets the fix.',
    },
    {
      title: 'See what it is doing.',
      body: 'A live board shows each AI teammate’s work and output, and you can see cost by teammate, person and model, so you can review it, steer it and answer “what did the AI do?” without asking around.',
    },
  ],
  media: {
    type: 'image',
    src: '/screenshots/cost-tooltip.png',
    alt: 'Session footer with a tooltip listing input, output, and cache tokens and an estimated cost for the session',
  },
};

export const teamsBeforeAfter: Array<{ before: string; after: string }> = [
  {
    before: 'Each person keeps their own prompts',
    after: 'One shared teammate the whole team runs',
  },
  { before: 'Results differ person to person', after: 'The same workflow, the same way' },
  {
    before: 'Good ideas leave when people do',
    after: 'The workflow stays and keeps improving',
  },
  {
    before: 'The work is hidden in private chats',
    after: 'Work and output on one board, cost by teammate, person and model',
  },
];

export const teamsSteps: Array<{ title: string; body: string }> = [
  { title: 'Join the open beta and connect Slack.', body: 'An admin installs the Slack app.' },
  {
    title: 'Turn one workflow into a teammate.',
    body: 'Start with something your best AI user already does well.',
  },
  { title: 'Your team asks in Slack.', body: 'You follow the work on the board.' },
];

export const teamsTeamLayer: LandingDetail = {
  id: 'team-layer',
  navLabel: 'The team layer',
  title: 'Chat tools are built for {one person} and {one conversation}.',
  body: [
    'Agor adds the team layer on top: shared teammates, work that is visible, and workflows that run the same way every time.',
  ],
};

export const teamsTrust: LandingDetail = {
  id: 'trust',
  navLabel: 'Trust',
  title: 'Built for teams that care {who sees what}',
  body: [
    'Shared prompting is off by default. Admins turn it on for the boards and teammates they choose, and a teammate uses the credentials of the person prompting it. Agor runs with fail-closed local sandboxing.',
    'Agor is source-available under BSL 1.1, and production use is permitted.',
  ],
  links: [{ label: 'View the code on GitHub', href: GITHUB_REPO_URL }],
};

/** `answer` may hold one inline link, written as [label](href). */
export const teamsFaq: Array<{ question: string; answer: string }> = [
  {
    question: 'Do we need to be technical?',
    answer:
      'Your team uses teammates by asking in Slack. Connecting Slack takes an admin, and we can help in a demo.',
  },
  {
    question: 'Which AI models does it use?',
    answer:
      'Agor works with Claude, Codex, Gemini and OpenCode. You pick the agent and model per task.',
  },
  {
    question: 'Can we self-host?',
    answer: 'Yes. See the [self-host guide](/guide/getting-started).',
  },
  {
    question: 'Who can use a teammate?',
    answer:
      'Only people an admin has given access. Shared prompting is off until an admin turns it on.',
  },
];
