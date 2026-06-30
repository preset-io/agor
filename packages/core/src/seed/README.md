# Development Fixtures (Seeding)

Quick-start your Agor development environment with pre-populated test data.

There are **two independent, composable seeders**, each gated by its own env var:

| Switch               | Seeder             | What it does                                                                                                 |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `SEED=true`          | `seedDevFixtures`  | Clones the **real** `agor` repo + creates one real, runnable `test-branch` (does git/network).               |
| `LOAD_FIXTURES=true` | `loadDemoFixtures` | Inserts a rich set of **hardcoded fake data** (`demo-`-prefixed). Pure DB inserts — no git/network/executor. |

They are orthogonal — enable either or both. The **recommended combo for instant
end-to-end testing** is:

```bash
SEED=true LOAD_FIXTURES=true docker compose up
```

…which gives you a real runnable branch **plus** a fully-populated demo board you
can log into. See [Demo Fixtures](#demo-fixtures-load_fixtures) below.

## What Gets Seeded?

The default seed (`seedDevFixtures`) creates:

- **Agor Repository** - Clones https://github.com/preset-io/agor.git
- **Test Branch** - Creates a branch named `test-branch`

## Usage

### Docker (Recommended)

Start your Docker environment with seeding enabled:

```bash
SEED=true docker compose up -d
```

The seed runs automatically on first boot and is **idempotent** (skips if data already exists).

### Manual (CLI)

Run the seed script directly:

```bash
# From repo root
pnpm seed

# Or with skip-if-exists flag
pnpm seed --skip-if-exists

# Or via tsx
pnpm tsx scripts/seed.ts
```

### Programmatic

```typescript
import { seedDevFixtures } from '@agor/core/seed';

const result = await seedDevFixtures({
  skipIfExists: true,
  baseDir: '/custom/path',
  userId: 'my-user-id',
});

console.log(result.repo_id);
console.log(result.branch_id);
```

## Demo Fixtures (`LOAD_FIXTURES`)

`loadDemoFixtures` (gated by `LOAD_FIXTURES=true`) populates a fresh dev/test
database with a rich set of **hardcoded fake data** so the UI is immediately
browsable and testable. It performs **pure DB inserts** — no git clone, no
network, no executor — and runs **inside a single transaction** (all-or-nothing).
It is **idempotent** (re-running is a no-op) and **dev-only** (never enable in
production: the demo credentials below are well-known).

Everything it creates is **`demo-`/`demo.`-prefixed**, so it never collides with
the real `agor` repo (or its `test-branch`) created by `SEED`.

### What gets seeded

- **4 users** — loginable, bcrypt-hashed passwords (see credentials below).
- **3 card types** — 🐛 Demo Bug / ✨ Demo Feature / ✅ Demo Task.
- **2 repos** — `demo-webapp` (local) and `demo-api` (remote), placeholder paths.
- **1 board** — "Demo Board" with 4 **zones**: To Do / In Progress / Review / Done.
- **5 branches** — placed on the board and pinned into zones (no git ops).
- **4 sessions** — terminal status, with **genealogy** (one spawned child + one
  forked sibling of a root session).
- **4 tasks** + **16 transcript messages** (including a `tool_use`/`tool_result`
  exchange).
- **4 kanban cards** — placed into zones.
- **1 public Sandpack artifact** — a tiny React counter app.

### Usage

```bash
# Docker — recommended combo (real branch + rich fakes), run directly on a host
SEED=true LOAD_FIXTURES=true docker compose up

# Just the demo data
LOAD_FIXTURES=true docker compose up

# Manual (CLI), from repo root
pnpm load:fixtures
pnpm load:fixtures --skip-if-exists
pnpm tsx scripts/load-fixtures.ts --skip-if-exists --user-id <admin-uuid>
```

#### In an Agor-managed env

Agor-managed environments start from a pre-rendered command in [`.agor.yml`](../../../../.agor.yml),
so you can't inject `LOAD_FIXTURES` by hand. Instead, pick a demo variant — these
are the `sqlite` / `postgres` variants with `LOAD_FIXTURES=true` added alongside
`SEED=true`:

- **`sqlite-demo`** — SQLite + demo fixtures.
- **`postgres-demo`** — Postgres + demo fixtures.

Select one via the **Branch → Environment** tab variant picker, the MCP call
`agor_environment_set({ branchId, variant: "sqlite-demo", andStart: true })`, or at
branch creation with `variant: "sqlite-demo"`.

The docker entrypoint runs `LOAD_FIXTURES` **after** `SEED`. Passing
`--user-id <admin-uuid>` (the entrypoint passes the bootstrapped admin) also adds
that user as an owner of the demo board/branches; otherwise the demo entities are
owned by the demo users.

```typescript
import { loadDemoFixtures } from '@agor/core/seed/demo-fixtures';

const result = await loadDemoFixtures({ skipIfExists: true });
console.log(result.skipped, result.counts);
```

### Test user credentials (dev-only)

These are printed in the seed log on load. The bootstrap admin (`admin@agor.live`)
is created by Agor's first-run setup; the `demo.*` users are created by
`LOAD_FIXTURES`.

| Email                  | Password              | Role       | Source              |
| ---------------------- | --------------------- | ---------- | ------------------- |
| `admin@agor.live`      | `admin`               | superadmin | first-run bootstrap |
| `demo.alice@agor.live` | `demo-password-alice` | admin      | `LOAD_FIXTURES`     |
| `demo.bob@agor.live`   | `demo-password-bob`   | member     | `LOAD_FIXTURES`     |
| `demo.carol@agor.live` | `demo-password-carol` | member     | `LOAD_FIXTURES`     |
| `demo.dave@agor.live`  | `demo-password-dave`  | viewer     | `LOAD_FIXTURES`     |

> The `admin@agor.live` / `admin` default is development-only and refused when
> `NODE_ENV=production`. Demo users exist only when `LOAD_FIXTURES` is enabled.

### Files

- **`packages/core/src/seed/demo-fixtures.ts`** — `loadDemoFixtures` (uses repositories)
- **`scripts/load-fixtures.ts`** — CLI wrapper script
- **`docker/docker-entrypoint.sh`** — Docker integration (checks `LOAD_FIXTURES`)
- **`docker-compose.yml`** — exposes `LOAD_FIXTURES`
- **`package.json`** — `pnpm load:fixtures` script

## Adding Custom Seed Data

Extend the seed with your own test data:

### Option 1: Modify `dev-fixtures.ts`

Edit `packages/core/src/seed/dev-fixtures.ts` and add your seed logic to `seedDevFixtures()`:

```typescript
export async function seedDevFixtures(options: SeedOptions = {}): Promise<SeedResult> {
  // ... existing code ...

  // Add your custom seed here!
  const myRepo = await repoRepo.create({
    slug: 'my-project',
    name: 'My Project',
    repo_type: 'remote',
    remote_url: 'https://github.com/me/my-project.git',
    local_path: path.join(baseDir, 'my-project'),
    default_branch: 'main',
  });

  // Return custom result
  return {
    repo_id: repo.repo_id,
    branch_id: branch.branch_id,
    skipped: false,
  };
}
```

### Option 2: Use `addCustomSeed` Helper

```typescript
import { addCustomSeed } from '@agor/core/seed';
import { getDatabase, RepoRepository } from '@agor/core/db';

await addCustomSeed(async () => {
  const db = getDatabase();
  const repoRepo = new RepoRepository(db);

  await repoRepo.create({
    slug: 'my-project',
    // ...
  });
});
```

## Files

- **`packages/core/src/seed/dev-fixtures.ts`** - Main seed logic (uses repositories)
- **`scripts/seed.ts`** - CLI wrapper script
- **`docker-entrypoint.sh:38-41`** - Docker integration (checks `SEED` env var)
- **`package.json:34`** - `pnpm seed` script

## How It Works

1. Checks if data already exists (via `skipIfExists` flag)
2. Clones Agor repo to `~/.agor/repos/agor` (or custom `baseDir`)
3. Creates repo record in database
4. Creates branch record in database
5. Returns result with IDs

## Troubleshooting

**Seed runs every time I restart Docker**

- The seed should be idempotent and skip if data exists
- Check if your database volume is persisted (`docker volume ls`)
- Try: `docker compose down -v` to reset volumes

**Clone fails**

- Ensure git is installed in Docker container (it is in `Dockerfile.dev`)
- Check network connectivity
- Try SSH key authentication for private repos

**Import errors**

- Ensure `@agor/core` is built: `pnpm --filter @agor/core build`
- Check that `packages/core/src/seed/index.ts` exports all seed functions
