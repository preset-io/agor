export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;
  image?: string;
}

/** Blog posts ordered newest-first. Keep in sync with pages/blog/*.mdx frontmatter. */
export const blogPosts: BlogPost[] = [
  {
    slug: 'agor-assistants',
    title: 'Introducing Agor Assistants',
    description:
      'What started as an OpenClaw experiment is now a first-class Agor feature. Meet Assistants — persistent AI entities with memory, skills, and team-wide reach through Slack.',
    date: '2026-03-03',
    image: '/images/blog/agor-assistants.png',
  },
  {
    slug: 'agor-openclaw',
    title: 'Agor-OpenClaw: OpenClaw Patterns Running 100% Inside Agor',
    description:
      'I recreated the OpenClaw agent framework to run entirely within Agor — persistent agents with full visibility, introspection, and multi-agent coordination on a spatial canvas.',
    date: '2026-02-04',
    image: '/images/blog/agor-openclaw.png',
  },
  {
    slug: 'openclaw',
    title: 'Agor vs. OpenClaw (ClawdBot): Thoughts on Agent Orchestration',
    description:
      'What the fastest-growing open-source project teaches us about agentic AI, and how Agor brings similar capabilities to developer workflows.',
    date: '2026-02-03',
    image: '/images/blog/openclaw-comparison.png',
  },
  {
    slug: 'agor-cloud',
    title: 'Agor Cloud — Opening a Private Beta',
    description:
      'Fully managed Agor with Unix-level isolation, analytics dashboards, policy controls, and enterprise observability.',
    date: '2025-11-23',
    image: '/images/blog/agor-cloud.png',
  },
  {
    slug: 'agor-platform',
    title: 'More Than a GUI: Agor is a Full Platform to Orchestrate AI Agents',
    description:
      "Agor's rich GUI sits atop a fully-typed REST API, powerful CLI, and TypeScript client enabling git worktree management, agent orchestration from CI/CD, and custom workflows.",
    date: '2025-11-16',
    image: '/images/blog/agor-platform.png',
  },
  {
    slug: 'orchestration-layers',
    title: 'The Future of Software Engineering is Agent Orchestration',
    description:
      'Software development evolved from copy-pasting prompts to orchestrating multiple AI agents. Here is how we got here and what comes next.',
    date: '2025-11-15',
    image: '/images/blog/orchestration-layers.png',
  },
  {
    slug: 'context-engineering',
    title: 'Context Engineering the @mistercrunch Way',
    description:
      'Keep AI context maintainable: bite-sized md nuggets in a context/ folder, cross-linked and treated like code.',
    date: '2025-10-29',
    image: '/images/blog/context-engineering.png',
  },
  {
    slug: 'announcement',
    title: 'Agor: A Multiplayer-ready, Spatial Layer for Agentic Coding',
    description:
      'Agent orchestration across Claude Code, Codex, and Gemini on a real-time spatial board with session trees, zone triggers, and per-worktree environments.',
    date: '2025-10-26',
    image: '/images/blog/announcement.png',
  },
  {
    slug: 'making-of-agor',
    title: 'The Making of Agor',
    description:
      'Behind the scenes of building Agor — from solving session context loss to creating a multiplayer platform for AI agent orchestration.',
    date: '2025-10-25',
    image: '/images/blog/making-of-agor.png',
  },
];
