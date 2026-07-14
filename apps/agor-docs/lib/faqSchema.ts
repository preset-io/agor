/**
 * FAQPage JSON-LD for /faq. Google requires the Q&A content to be VISIBLE on
 * the page — every entry here is a condensed summary of a question that
 * appears verbatim as a heading in content/faq.mdx, with the answer drawn
 * from that section's visible copy. If faq.mdx questions change, update this
 * list to match (schema for questions not on the page violates Google's
 * structured-data guidelines).
 */

const faqItems: Array<{ question: string; answer: string }> = [
  {
    question: "What's a branch?",
    answer:
      'A branch is an isolated working directory for a git repository. Agor manages git branches for you automatically (in ~/.agor/worktrees/<repo>/<name>), tracks metadata like issue and PR URLs, and associates all AI sessions with the branch. Best practice: 1 branch = 1 issue = 1 PR = 1 feature. Each branch is completely isolated, so you can work on multiple features simultaneously without switching branches or stashing changes.',
  },
  {
    question: 'Can Agor work on multiple repos or branches?',
    answer:
      'Yes. If one repo clearly depends on another, use git submodules so the agent can inspect and modify both codebases from one working directory. For coordinated work across independent repos, create Agor branches for the same feature in each repo and ask an orchestrating agent to coordinate across them — Agor provides the control plane: multiple isolated branches, visible on boards, with agents that can coordinate across them.',
  },
  {
    question: 'Session trees? WTF?',
    answer:
      'Sessions in Agor can fork and spawn, creating genealogy trees. Fork creates a sibling session with a copy of the conversation context; spawn creates a child session with a fresh, curated context window. Every fork and spawn keeps its full conversation history and can be inspected, re-prompted, or branched again — so you can branch your conversations the way git branches code.',
  },
  {
    question: 'Why a spatial layout for AI coding sessions?',
    answer:
      'Because your brain thinks spatially and complex work is inherently non-linear. A 2D board gives every branch and session a "place" (location-based memory), lets workflows organize organically, supports zones as visual workflow stages, and makes real-time multiplayer collaboration natural — like Figma for AI coding.',
  },
  {
    question: 'Zones? Zone "triggers"?',
    answer:
      'Zones are spatial regions on boards with Handlebars prompt templates. Dropping a branch into a zone fires the template with the branch context (issue URL, PR URL, notes, custom JSON) automatically injected — templated workflow automation for AI sessions. Drag to trigger; context flows automatically.',
  },
  {
    question: 'What happens when I "fork" a session?',
    answer:
      'Forking creates a sibling session with a copy of the conversation context at that moment. You fork the context window, not the git branch — both sessions keep working on the same branch and filesystem. Use forks for parallel work that needs the same starting context but different focus, like writing tests, building a dependent feature, or generating documentation.',
  },
  {
    question: 'What happens when I "spawn" a subsession?',
    answer:
      'Spawning creates a child session with a fresh context window: the parent agent packages only the relevant context based on your spawn prompt. The subsession gets a clean context without the parent’s clutter, its work does not pollute the parent’s context, and its full history is kept, so you can inspect it, prompt it again, or branch from it.',
  },
  {
    question: 'When should I fork a session vs create a new branch?',
    answer:
      'Use different branches for isolation: different features or issues, competing implementations, or work that would conflict on disk. Fork a session within a branch for parallel work on the same feature that needs the same starting context and won’t conflict on the filesystem — implementation, tests, docs, and review can all share one branch.',
  },
  {
    question: "What does Agor's open-source telemetry collect?",
    answer:
      'When enabled, Agor sends lightweight anonymous install and aggregate usage summaries: version, install channel, OS family, deployment kind, broad configuration modes, and aggregate counts like sessions and prompts. It never sends prompts, messages, repo names, file paths, code, emails, secrets, or tokens. Disable it with AGOR_TELEMETRY=0, DO_NOT_TRACK=1, or "agor telemetry off".',
  },
];

export const FAQ_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqItems.map(({ question, answer }) => ({
    '@type': 'Question',
    name: question,
    acceptedAnswer: {
      '@type': 'Answer',
      text: answer,
    },
  })),
};
