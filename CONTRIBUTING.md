# Contributing to Agor

Thank you for your interest in contributing to Agor! 🚀

**📚 Complete contribution guide:** https://agor.live/guide/development

The documentation covers everything you need:

- Setup instructions (Docker or local pnpm)
- Monorepo tooling (pnpm, Turbo, Husky, biome)
- Tech stack and architecture
- Roadmap and contribution ideas
- Code standards and patterns
- Troubleshooting

---

## Quick Start

```bash
git clone https://github.com/preset-io/agor
cd agor
docker compose up
# Visit http://localhost:5173 → Login: admin@agor.live / admin
```

---

## Contribution Workflow

### 1. Fork & Create a Worktree

**In Agor (meta!):**

```bash
# Create a worktree in Agor for your contribution
# Work on it using Agor sessions
# Experience the workflow you're improving!
```

**Or traditionally:**

```bash
git checkout -b feat/your-feature-name
```

**Want to discuss first?** Feel free to open an issue or discussion before coding, but it's not required. Direct PRs are welcome!

### 2. Make Your Changes

**Follow these patterns:**

- **Read before editing** - Always read files before modifying
- **Type-driven development** - Use branded types for IDs, strict TypeScript
- **Centralize types** - Import from `packages/core/src/types/`, never redefine
- **Use `simple-git`** - NEVER use `execSync`, `spawn`, or subprocess for git operations
- **Edit over Write** - Prefer editing existing files when possible

**Code style:**

- TypeScript strict mode
- ESLint + Prettier (run `pnpm lint` before committing)
- Meaningful variable names
- Comments for non-obvious logic

### 3. Test Your Changes

```bash
# Type checking
pnpm typecheck

# Lint
pnpm lint

# Manual testing
# - Create a session in Agor
# - Test your feature end-to-end
# - Check for console errors in browser/daemon logs
```

**We need more automated tests!** Adding tests with your PR is highly valued.

### 4. Commit & Push

**Commit message format:**

```
<type>: <short description>

<optional longer description>

<optional footer>
```

**Types:**

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `refactor:` - Code refactoring without behavior change
- `test:` - Adding or updating tests
- `chore:` - Tooling, dependencies, configs

**Examples:**

```
feat: add rich diff visualization for Edit tool

Implements side-by-side and inline diff views using react-diff-view.
Adds syntax highlighting and expand/collapse for large diffs.

Closes #123
```

```
fix: environment health check timeout handling

Health checks now retry 3 times with exponential backoff before
marking environment as unhealthy.
```

### 5. Open a Pull Request

**PR title:** Same format as commit messages

**PR description should include:**

- **What** - What does this PR do?
- **Why** - Why is this change needed?
- **How** - Brief explanation of approach (if non-obvious)
- **Testing** - How did you test this? What should reviewers check?
- **Screenshots** - For UI changes, always include before/after screenshots
- **Closes #XXX** - Link to related issue(s)

**Example PR description:**

```markdown
## What

Adds rich diff visualization for Edit tool with syntax highlighting and side-by-side view.

## Why

The current Edit tool output is plain text, making it hard to review what changed.
Developers need to see diffs clearly to understand agent actions.

## How

- Uses `react-diff-view` for rendering
- Integrates with `highlight.js` for syntax highlighting
- Adds expand/collapse for diffs >100 lines
- Supports both unified and split view modes

## Testing

- Created a session that edits TypeScript files
- Verified syntax highlighting works for TS, JS, Python, Rust
- Tested expand/collapse with large diffs (500+ lines)
- Checked mobile responsiveness

## Screenshots

### Before

![before](...)

### After

![after](...)

Closes #123
```

---

## Code Review Process

**What to expect:**

- Reviews usually happen within 2-3 days
- Maintainers may request changes or ask questions
- CI checks must pass (linting, type checking)
- At least one maintainer approval required

**Making changes:**

- Push new commits to your PR branch
- Respond to review comments
- Mark conversations as resolved when addressed

**After merge:**

- Your PR will be merged via squash commit
- You'll be added to contributors list
- Feature will ship in next release

---

## Community Guidelines

**Be respectful and constructive**

- Assume good intent
- Provide actionable feedback
- Celebrate contributions, no matter how small

**Ask questions!**

- Confused about architecture? Ask in Discussions
- Stuck on implementation? Open a draft PR and ask for guidance
- Found unclear docs? Ask AND submit a fix!

**Collaborate in public**

- Use GitHub Issues/Discussions for questions (not DMs)
- Share your learnings and solutions
- Help other contributors when you can

---

## Getting Help

**Stuck? Confused? Need guidance?**

- **[GitHub Discussions](https://github.com/preset-io/agor/discussions)** - Ask questions, share ideas, get help
- **[GitHub Issues](https://github.com/preset-io/agor/issues)** - Report bugs, request features
- **Read the docs** - [CLAUDE.md](CLAUDE.md) and [context/](context/) have extensive documentation

**Response time:**

- Discussions: Usually within 24-48 hours
- Issues/PRs: Within 2-3 days
- Critical bugs: Within 24 hours

---

## Recognition

**All contributors are valued!** We recognize contributions through:

- **Contributors list** in README
- **Release notes** crediting contributors
- **GitHub badges** for merged PRs
- **Maintainer nomination** for sustained, high-quality contributions

---

## License

By contributing to Agor, you agree that your contributions will be licensed under the [Business Source License 1.1](LICENSE).

---

**Thank you for considering contributing to Agor!**

Your contributions make this project better for everyone. Whether you're fixing a typo, improving docs, or building a major feature - every contribution matters.

**Remember: Use Agor to contribute to Agor!** Experience the tool, find the rough edges, and help us smooth them out.

Let's build the future of multiplayer AI development together. 🚀

---

## `.agor.yml` Configuration

Agor supports automatic environment configuration via `.agor.yml` in your repository root.

### Schema

Place a `.agor.yml` file in your repository root with the following structure:

```yaml
environment:
  start: 'docker compose up -d'
  stop: 'docker compose down'
  health: 'http://localhost:{{add 9000 worktree.unique_id}}/health'
  app: 'http://localhost:{{add 5000 worktree.unique_id}}'
  logs: 'docker compose logs --tail=100'
```

**Required fields:**

- `start` - Command to start the environment
- `stop` - Command to stop the environment

**Optional fields:**

- `health` - HTTP URL for health checks
- `app` - Application URL to open in browser
- `logs` - Command to fetch recent logs

### Template Variables

Use Handlebars syntax in your commands:

- `{{worktree.unique_id}}` - Auto-assigned unique number (1, 2, 3, ...) for port allocation
- `{{worktree.name}}` - Worktree name (e.g., "feat-auth", "main")
- `{{worktree.path}}` - Absolute path to worktree directory
- `{{repo.slug}}` - Repository slug
- `{{add a b}}` - Math helpers: `add`, `sub`, `mul`, `div`, `mod`
- `{{custom.your_var}}` - Custom context variables (defined per worktree)

### Examples

**Docker Compose with dynamic ports:**

```yaml
environment:
  start: 'DAEMON_PORT={{add 3000 worktree.unique_id}} UI_PORT={{add 5000 worktree.unique_id}} docker compose -p {{worktree.name}} up -d'
  stop: 'docker compose -p {{worktree.name}} down'
  health: 'http://localhost:{{add 5000 worktree.unique_id}}/health'
  app: 'http://localhost:{{add 5000 worktree.unique_id}}'
  logs: 'docker compose -p {{worktree.name}} logs --tail=100'
```

**Simple dev server:**

```yaml
environment:
  start: 'PORT={{add 5000 worktree.unique_id}} pnpm dev'
  stop: "pkill -f 'vite.*{{add 5000 worktree.unique_id}}'"
  health: 'http://localhost:{{add 5000 worktree.unique_id}}/api/health'
  app: 'http://localhost:{{add 5000 worktree.unique_id}}'
```

### Workflow

**Auto-Import (Recommended):**

1. Add `.agor.yml` to your repo root and commit it
2. Clone the repo in Agor → configuration auto-loaded ✨
3. All worktrees created from this repo inherit the configuration

**Manual Import:**

1. Open any worktree from the repository
2. Go to WorktreeModal → Environment tab
3. Click "Import" button (⬇️ icon)
4. Configuration loaded from `.agor.yml`

**Manual Export:**

1. Configure environment in the UI
2. Click "Export" button (⬆️ icon)
3. `.agor.yml` written to repository root
4. Commit and share with your team

### Benefits

- **Share configuration** across team via version control
- **Automatic port allocation** prevents conflicts between worktrees
- **Consistent setup** for all developers
- **No manual configuration** when cloning repos

### Notes

- Start command should run in background (e.g., `docker compose up -d`, not `docker compose up`)
- Health check URL should return 200 OK when environment is ready
- Templates are rendered when worktree is created (not at runtime)
- After creation, values are editable per-worktree in the UI
