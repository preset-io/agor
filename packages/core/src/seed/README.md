# Development Fixtures (Seeding)

Quick-start your Agor development environment with pre-populated test data.

## What Gets Seeded?

The default seed (`seedDevFixtures`) creates:

- **Agor Repository** - Clones https://github.com/preset-io/agor.git
- **Test Worktree** - Creates a worktree named `test-worktree`

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
console.log(result.worktree_id);
```

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
    worktree_id: worktree.worktree_id,
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
4. Creates worktree record in database
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
