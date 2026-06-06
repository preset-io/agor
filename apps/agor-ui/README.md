# Agor UI

React UI for Agor's multiplayer agent workspace.

## Tech Stack

- **Vite + React + TypeScript** - Fast, modern development
- **Ant Design** - UI component library
- **React Flow** - Interactive board/canvas visualization
- **Vitest + Testing Library** - Focused component and hook tests

## Getting Started

```bash
# Install dependencies from the repo root
pnpm install

# Start the UI dev server
pnpm --filter agor-ui dev

# Run type checking
pnpm --filter agor-ui typecheck

# Run linter
pnpm --filter agor-ui lint

# Build for production
pnpm --filter agor-ui build
```

## Project Structure

```
src/
├── components/     # React components
├── contexts/       # React context providers
├── hooks/          # Shared hooks
├── utils/          # UI utilities
└── types/          # UI-local types
```

## Development

We develop and test UI changes against the live Agor dev environment instead of a separate component catalog. Keep reusable components small, prefer Ant Design tokens for styling, and add targeted Vitest/Testing Library coverage for behavior that can regress.

## Scripts

- `pnpm --filter agor-ui dev` - Start Vite dev server
- `pnpm --filter agor-ui typecheck` - Run TypeScript type checking
- `pnpm --filter agor-ui lint` - Run Biome linter
- `pnpm --filter agor-ui test` - Run Vitest tests
- `pnpm --filter agor-ui build` - Build for production
- `pnpm --filter agor-ui preview` - Preview production build

## Linting

This project uses [Biome](https://biomejs.dev/) for linting and formatting. Configuration is in the root `biome.json` file, which includes:

- React hooks validation
- Accessibility (a11y) rules
- Unused imports/variables detection
- Consistent code formatting

Biome automatically runs on all files via pre-commit hooks (lint-staged).
