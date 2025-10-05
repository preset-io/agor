# Job Stories

> Note: agor needs to work for both humans (locally) and Tembo (background cloud tasks). While humans may prefer UI, Tembo platform would require a CLI or API/SDK. Ideally both humans and Tembo generate the same artifacts, so humans can transfer sessions to Tembo and vice versa - Tembo is just another dev.

> **Job Story Format:** "When [situation], I want to [motivation], so I can [expected outcome]"

## p1 mvp

open source - when I'm choosing AI development infrastructure, I want open source and vendor-neutral solutions, so I can avoid lock-in and contribute to community-driven improvements.

agent agnostic - When I'm context-switching between agents, I want zero conflicts and seamless transitions, so I can use the best tool for each specific task without workflow disruption.

agor-cli - `agor session start --agent <agent> --concepts <concepts> --task <task>` - When I want to start a coding agent session, I want a CLI that allows me to specify the agent, the context, and the task, so I can start a session with a single command from the terminal. Ideally this uses Tembo's existing TS code. I want git worktrees for session isolation, so I can explore alternatives without affecting primary branch. I want a platform that orchestrates all agents rather than competing with them, so I can use best-of-breed tools while maintaining unified workflow.

session subtask spawning - `agor session subtask <session-id>` - When I have a complex task that requires focused subtasks, I want to spawn new sessions with specific agents and concepts, so I can tackle problems modularly while maintaining relationships to the parent work.

agor-app - When I'm working with multiple concurrent sessions, I want a unified interface that visually maps my sessions, so I use agents efficiently, understand what i have running at a glance, and build on past work without using terminal. The app would run commands for me automatically. When I'm working with multiple agents on different aspects (Claude Code for backend, Cursor for frontend, Gemini for schemas), I want them all orchestrated in one workspace, so I can maintain visibility and coordination across tools.

git provenance - When I complete AI-assisted coding sessions, I want to track which sessions produced which code changes, so I can understand the provenance of my codebase.

git history - When I'm reviewing past work, I want to see git state and task checkpoints for each session, so I can understand the complete history of how code evolved.

session visualization - When I want to understand which explorations succeeded or stalled, I want visual indicators in my session tree, so I can quickly identify productive patterns and dead ends.

## p2 session pause, resume, fork

session pause - `agor session pause <session-id>` - When I want to pause a session, I want to save its state and resume it later, so I can continue conversations seamlessly where I left off.

session resume - `agor session resume <session-id>` - When I want to resume previous work, I want to jump into any session with a CLI command or a click in the app, so I can continue conversations seamlessly where I left off.

session fork - `agor session fork <session-id>` - When I need to explore different approaches to the same problem, I want to fork sessions at decision points, so I can try alternatives without losing my current progress.

## p3 knowledge

agor-concepts - When I'm managing context across multiple agents, I want concepts as first-class composable primitive, so I can engineer context systematically rather than relying on ad-hoc prompt templates.

learnings auto-recording - When I complete tasks with AI agents, I want post-task hooks to generate structured learnings automatically, so I can capture what worked and what didn't without manual documentation overhead.

learnings search - When I'm starting new work that's similar to past projects, I want to search all my reports and learnings, so I can reuse successful approaches and avoid repeating mistakes.

context concepts - When I need context for a new session, I want modular concept nuggets that I can compose into session-specific knowledge, so I can provide relevant background without overwhelming the agent.

concept organization - When I'm working across different domains (auth, database, API design), I want concepts organized and tagged, so I can quickly pull in relevant context for each session.

## p4 mutli-player

Team Collaboration - When I'm working on a team, I want to share session trees like git repositories, so my teammates can explore past decisions and understand the reasoning behind code changes.

Team Onboarding - When I'm onboarding new team members, I want them to explore past sessions to understand decisions, so they can get up to speed faster without lengthy documentation reviews.

Team Pattern Recognition - When I'm looking for patterns across team work, I want to find similar past work and reuse approaches, so we can build institutional knowledge and avoid reinventing solutions.

Audit Trail - When I need an audit trail of AI-assisted development, I want complete provenance of code changes linked to conversations, so we can understand and validate the decision-making process.
