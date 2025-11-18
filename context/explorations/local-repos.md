# Local Repository Support

**Status:** 📝 Exploration (Proposed)
**Related:** [worktrees.md](../concepts/worktrees.md), [architecture.md](../concepts/architecture.md)

---

## Overview

Enable Agor to work with existing local git repositories without requiring a clone operation. Instead of cloning repos into `~/.agor/repos/`, Agor will reference the user's existing local repository and use it as a base for creating worktrees.

### What This Adds

**New repository type:** Local (unmanaged) repositories alongside existing remote-cloned repositories

**Key features:**

- Add local repos by path instead of URL
- Use existing repo as base for worktree creation (read-only operations)
- Support both local and remote repos simultaneously
- Maintain all existing worktree capabilities
- Zero modifications to user's original repository working tree

---

## Motivation

### Current Behavior

Today, adding a repository to Agor requires:

1. Providing a git remote URL (SSH or HTTPS)
2. Agor clones the repository to `~/.agor/repos/{slug}/`
3. Worktrees are created from this managed clone

**Problems with current approach:**

- **Duplication:** User may already have the repo cloned locally
- **Disk space:** Large repos (monorepos, media assets) cloned twice
- **Out of sync:** User's local repo and Agor's clone can diverge
- **Workflow friction:** User must manage two copies (their working copy + Agor's copy)
- **Onboarding barrier:** Extra step to get started with existing projects

### Why Build This?

**1. Better Developer Experience**

- "Just point Agor at my existing repo" - instant onboarding
- No mental overhead of managing two copies
- Natural fit for existing workflows

**2. Disk Space Efficiency**

- Large monorepos (1GB+) only stored once
- Especially important for repos with binary assets, media, datasets

**3. Simplified Mental Model**

- One source of truth: user's local repo
- Agor's worktrees are clearly "derived" from user's repo
- Matches how users think about their codebase

**4. Faster Iteration**

- No waiting for clone on first use
- Fetch operations are faster (local repo likely already up-to-date)

---

## Design

### Core Principle: Read-Only Base Repository

**Safety Guarantee:** Agor will NEVER modify the working tree of a local repository.

**Allowed operations on local repos:**

- `git fetch origin` - Updates remote tracking branches in `.git/`
- `git worktree add` - Creates worktree linked to local repo
- `git branch -f <ref> origin/<ref>` - Updates local branch refs (metadata only)
- Reading git metadata (branches, commits, refs)

**Forbidden operations on local repos:**

- Modifying tracked files in working tree
- Creating/modifying/deleting files outside `.git/`
- `git checkout` / `git switch` (changes working tree)
- `git reset --hard` (changes working tree)
- `git clean` (deletes untracked files)

**Implementation:** Git's worktree mechanism naturally provides this isolation. All worktree operations happen in the worktree directory, not the base repo.

---

## Data Model Changes

### 1. Repo Type Distinction

**Current schema:**

```typescript
interface Repo {
  repo_id: UUID;
  slug: RepoSlug;
  name: string;
  remote_url: string; // Always required
  local_path: string; // Always ~/.agor/repos/{slug}
  default_branch?: string;
  environment_config?: RepoEnvironmentConfig;
}
```

**Proposed schema:**

```typescript
interface Repo {
  repo_id: UUID;
  slug: RepoSlug;
  name: string;

  // New: Repository type
  repo_type: 'remote' | 'local';

  // Optional: Only for remote repos
  remote_url?: string;

  // Required: Path to git repository
  // - For remote: ~/.agor/repos/{slug} (managed by Agor)
  // - For local: User-provided absolute path (e.g., ~/code/myapp)
  local_path: string;

  default_branch?: string;
  environment_config?: RepoEnvironmentConfig;

  // Metadata
  created_at: string;
  last_updated: string;
}
```

**Schema migration:**

```sql
-- Add repo_type column (default to 'remote' for existing repos)
ALTER TABLE repos ADD COLUMN repo_type TEXT NOT NULL DEFAULT 'remote';

-- Make remote_url nullable (required for remote, null for local)
-- Note: SQLite doesn't support ALTER COLUMN, so we'll handle this in application logic
```

**Database validation:**

- If `repo_type = 'remote'`, `remote_url` is required
- If `repo_type = 'local'`, `remote_url` should be null (or ignored)
- `local_path` is always required

---

### 2. Slug Generation for Local Repos

**Challenge:** Local repos don't have a URL to extract slug from.

**Options:**

**Option A: Auto-detect from directory name**

```
/Users/max/code/myapp → slug: "local/myapp"
/Users/max/code/company/backend → slug: "local/backend"
```

**Option B: Detect from git remote origin**

```bash
cd /Users/max/code/myapp
git remote get-url origin
# → "https://github.com/company/myapp.git"
# → Extract: "company/myapp"
```

**Option C: User provides slug explicitly**

```bash
agor repo add /Users/max/code/myapp --slug company/myapp
```

**Recommended: Hybrid approach**

1. Try Option B (detect from remote origin) - best UX when it works
2. Fall back to Option C (user provides slug) - required if no remote or non-standard setup
3. If neither provided, error with helpful message

**Slug conflict resolution:**

- If slug already exists, error and ask user to provide explicit slug
- Consider namespacing: `local/{dir-name}` vs `{org}/{name}` from URL

---

### 3. Worktree Path Construction

**Current:**

```
~/.agor/worktrees/{repo-slug}/{worktree-name}/

Example:
~/.agor/worktrees/preset-io/agor/feat-auth/
```

**Unchanged for local repos** - same structure works fine.

**Why not create worktrees inside user's repo?**

- Keeps Agor's managed worktrees separate from user's workflow
- Prevents accidental deletion/confusion
- User's repo directory stays clean
- Consistent experience for local and remote repos

---

## Implementation Plan

### Phase 1: Core Support

**1.1 Add repo type to schema**

Files to modify:

- `packages/core/src/types/repo.ts` - Add `repo_type` field
- `packages/core/src/db/schema.ts` - Add `repo_type` column, make `remote_url` optional in type
- `packages/core/src/db/repositories/repos.ts` - Handle validation logic

**1.2 Validate local repo path**

New utility function in `packages/core/src/git/index.ts`:

```typescript
/**
 * Validate that a path is a valid git repository
 *
 * @param path - Absolute path to check
 * @returns Promise<boolean>
 */
export async function isValidGitRepo(path: string): Promise<boolean> {
  try {
    // Check path exists
    const stats = await fs.stat(path);
    if (!stats.isDirectory()) return false;

    // Check if it's a git repo
    const git = createGit(path);
    await git.revparse(['--git-dir']); // Throws if not a git repo
    return true;
  } catch {
    return false;
  }
}

/**
 * Get remote URL from local repo (if exists)
 *
 * @param path - Path to git repository
 * @returns Promise<string | null> - Remote URL or null if no origin
 */
export async function getRemoteUrl(path: string, remote = 'origin'): Promise<string | null> {
  try {
    const git = createGit(path);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === remote);
    return origin?.refs.fetch || null;
  } catch {
    return null;
  }
}
```

**1.3 Slug auto-detection**

New utility function in `packages/core/src/config/repo-reference.ts`:

```typescript
/**
 * Extract slug for a local repository
 *
 * Strategy:
 * 1. Try to detect from git remote origin URL
 * 2. Fall back to user-provided slug
 * 3. Error if neither works
 *
 * @param path - Local repo path
 * @param explicitSlug - Optional user-provided slug
 * @returns Promise<RepoSlug>
 */
export async function extractLocalRepoSlug(path: string, explicitSlug?: string): Promise<RepoSlug> {
  // User provided explicit slug
  if (explicitSlug) {
    if (!isValidSlug(explicitSlug)) {
      throw new Error(`Invalid slug format: ${explicitSlug}`);
    }
    return explicitSlug as RepoSlug;
  }

  // Try to detect from remote origin
  const remoteUrl = await getRemoteUrl(path);
  if (remoteUrl && isValidGitUrl(remoteUrl)) {
    try {
      return extractSlugFromUrl(remoteUrl);
    } catch {
      // Fall through to error
    }
  }

  // No remote or invalid URL - require explicit slug
  throw new Error(
    `Could not auto-detect slug for local repository at ${path}.\n` +
      `Please provide a slug explicitly:\n` +
      `  agor repo add ${path} --slug org/name`
  );
}
```

**1.4 Update repo service**

Modify `apps/agor-daemon/src/services/repos.ts`:

```typescript
export class ReposService extends DrizzleService<Repo, Partial<Repo>, RepoParams> {
  /**
   * Add a local repository (new method)
   */
  async addLocalRepository(
    data: {
      path: string; // Absolute path to local repo (supports ~/home expansion)
      slug?: string; // Optional explicit slug
    },
    params?: RepoParams
  ): Promise<Repo> {
    let { path, slug: explicitSlug } = data;

    // 1. Expand home directory (~/) if needed
    if (path.startsWith('~/')) {
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      if (!homeDir) {
        throw new Error('Could not determine home directory');
      }
      path = path.replace('~', homeDir);
    }

    // 2. Validate path is absolute (after expansion)
    if (!isAbsolute(path)) {
      throw new Error(`Path must be absolute: ${path}`);
    }

    // 3. Validate path is a git repo
    const isValidRepo = await isValidGitRepo(path);
    if (!isValidRepo) {
      throw new Error(`Not a valid git repository: ${path}`);
    }

    // 4. Extract or validate slug
    const slug = await extractLocalRepoSlug(path, explicitSlug);

    // 5. Check if slug already exists
    const existing = await this.repoRepo.findBySlug(slug);
    if (existing) {
      throw new Error(
        `Repository '${slug}' already exists.\n` + `Use a different slug with: --slug custom/name`
      );
    }

    // 6. Get default branch
    const defaultBranch = await getDefaultBranch(path);

    // 7. Parse .agor.yml (if exists)
    const agorYmlPath = join(path, '.agor.yml');
    let environmentConfig: RepoEnvironmentConfig | null = null;

    try {
      environmentConfig = parseAgorYml(agorYmlPath);
    } catch (error) {
      console.warn(`⚠️  Failed to parse .agor.yml: ${error.message}`);
    }

    // 8. Get remote URL (for metadata/display)
    const remoteUrl = await getRemoteUrl(path);

    // 9. Extract repo name from slug
    const name = slug.split('/').pop() || slug;

    // 10. Create database record
    return this.create(
      {
        repo_type: 'local',
        slug,
        name,
        remote_url: remoteUrl || undefined, // Optional metadata
        local_path: path, // User's repo path
        default_branch: defaultBranch,
        environment_config: environmentConfig || undefined,
      },
      params
    );
  }

  /**
   * Clone repository (existing method - updated)
   */
  async cloneRepository(data: { url: string; slug: string }, params?: RepoParams): Promise<Repo> {
    // ... existing logic ...

    // Update to set repo_type: 'remote'
    return this.create(
      {
        repo_type: 'remote', // NEW
        slug,
        name,
        remote_url: data.url,
        local_path: result.path,
        default_branch: result.defaultBranch,
        environment_config: environmentConfig || undefined,
      },
      params
    );
  }
}
```

**1.5 Add REST API endpoint**

Modify `apps/agor-daemon/src/index.ts`:

```typescript
// New endpoint: Add local repo
app.use('/repos/local', {
  async create(data: { path: string; slug?: string }, params: RouteParams) {
    ensureMinimumRole(params, 'member', 'add local repositories');
    return reposService.addLocalRepository(data, params);
  },
});

// Existing endpoint (unchanged)
app.use('/repos/clone', {
  async create(data: { url: string; slug?: string }, params: RouteParams) {
    ensureMinimumRole(params, 'member', 'clone repositories');
    return reposService.cloneRepository(data, params);
  },
});
```

**1.6 Add CLI command**

New command: `apps/agor-cli/src/commands/repo/add-local.ts`

```typescript
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { BaseCommand } from '../../base';

export default class RepoAddLocal extends BaseCommand {
  static description = 'Add an existing local git repository to Agor';

  static examples = [
    '# Auto-detect slug from git remote',
    'agor repo add-local ~/code/myapp',
    '',
    '# Provide explicit slug',
    'agor repo add-local ~/code/myapp --slug company/myapp',
    '',
    '# Absolute path required',
    'agor repo add-local /Users/max/code/backend --slug acme/backend',
  ];

  static args = {
    path: Args.string({
      description: 'Absolute path to local git repository (supports ~/home expansion)',
      required: true,
    }),
  };

  static flags = {
    slug: Flags.string({
      char: 's',
      description: 'Custom slug (org/name) for the repository',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoAddLocal);
    const client = await this.connectToDaemon();

    try {
      // Pass path as-is to daemon (daemon will handle ~/expansion and validation)
      const path = args.path;

      this.log(chalk.dim(`Adding local repository: ${path}`));

      if (flags.slug) {
        this.log(chalk.dim(`Using slug: ${chalk.cyan(flags.slug)}`));
      } else {
        this.log(chalk.dim('Auto-detecting slug from git remote...'));
      }

      // Call daemon API (daemon handles path expansion and validation)
      const repo = await client.service('repos/local').create({
        path,
        slug: flags.slug,
      });

      // Success
      this.log(chalk.green('✓ Local repository added'));
      this.log('');
      this.log(`  ${chalk.bold('Slug:')} ${chalk.cyan(repo.slug)}`);
      this.log(`  ${chalk.bold('Path:')} ${repo.local_path}`);
      this.log(`  ${chalk.bold('Type:')} local`);
      if (repo.remote_url) {
        this.log(`  ${chalk.bold('Remote:')} ${chalk.dim(repo.remote_url)}`);
      }
      this.log(`  ${chalk.bold('Default branch:')} ${repo.default_branch || 'unknown'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('Not a valid git repository')) {
        this.log(chalk.red('✗ Not a valid git repository'));
        this.log(chalk.dim(`  Path: ${args.path}`));
        this.log(chalk.dim('\nMake sure the directory contains a .git folder'));
      } else if (message.includes('already exists')) {
        this.log(chalk.red('✗ Repository already exists'));
        this.log(chalk.dim(message));
      } else if (message.includes('Could not auto-detect slug')) {
        this.log(chalk.red('✗ Could not auto-detect slug'));
        this.log(chalk.dim(message));
      } else {
        this.log(chalk.red('✗ Failed to add local repository'));
        this.log(chalk.dim(message));
      }

      this.exit(1);
    }
  }
}
```

**1.7 Update existing CLI command**

Modify `apps/agor-cli/src/commands/repo/add.ts` to clarify it's for remote repos:

```typescript
export default class RepoAdd extends BaseCommand {
  static description = 'Clone a remote git repository and add it to Agor';

  static examples = [
    '# Clone from GitHub (HTTPS)',
    'agor repo add https://github.com/apache/superset.git',
    '',
    '# Clone from GitHub (SSH)',
    'agor repo add git@github.com:apache/superset.git',
    '',
    '# Custom slug',
    'agor repo add https://github.com/apache/superset.git --slug my/superset',
    '',
    '# For local repos, use: agor repo add-local <path>',
  ];

  // ... rest unchanged ...
}
```

**1.8 Update worktree creation (no changes needed)**

Good news: `createWorktree()` in `packages/core/src/git/index.ts` already works correctly.

It receives `repoPath` as a parameter and doesn't care if it's:

- `~/.agor/repos/{slug}` (remote repo managed by Agor)
- `/Users/max/code/myapp` (local repo managed by user)

All git operations are isolated to:

- `.git/` metadata (safe)
- New worktree directory (not in base repo)

**No modifications needed** to worktree creation logic.

---

### Phase 2: Enhanced UX

**2.1 Detect repo type in CLI output**

Update `agor repo list` to show repo type:

```
ID        Slug             Type    Path                           Remote
────────────────────────────────────────────────────────────────────────
01abc123  preset-io/agor   remote  ~/.agor/repos/preset-io/agor   git@github.com:preset-io/agor.git
01def456  acme/myapp       local   ~/code/myapp                   git@github.com:acme/myapp.git
01ghi789  local/backend    local   ~/code/backend                 (no remote)
```

**2.2 Warning when adding local repo with uncommitted changes**

```typescript
async addLocalRepository(data, params): Promise<Repo> {
  // ... validation ...

  // Check for uncommitted changes (warning only)
  const git = createGit(path);
  const status = await git.status();

  if (!status.isClean()) {
    console.warn(
      chalk.yellow('⚠️  Warning: Local repository has uncommitted changes.\n') +
      chalk.dim('   Agor will not modify your working tree, but you may want to commit or stash changes.')
    );
  }

  // ... continue ...
}
```

**2.3 Update UI to show repo type**

In `apps/agor-ui/`, add visual distinction:

- Remote repos: Show clone icon, remote URL
- Local repos: Show folder icon, local path, note "User-managed"

**2.4 Environment config handling**

For local repos, `.agor.yml` is in user's repo. Consider:

- Watch for changes? (Optional - probably not needed)
- Warn if edited? (No - user is managing their repo)
- Re-parse on worktree creation? (Yes - already done)

---

### Phase 3: Advanced Features (Future)

**3.1 Sync status indicator**

For local repos, show if user's repo is behind/ahead of origin:

```bash
agor repo status acme/myapp
# → Local: 3 commits ahead of origin/main
# → Local: 2 commits behind origin/main
```

**3.2 Support bare repositories**

Users may have bare repos locally (e.g., `~/git/myapp.git`). These have no working tree.

**Proposal:** Detect bare repos and handle them like remote clones (no working tree to protect).

```typescript
export async function isBareRepo(path: string): Promise<boolean> {
  try {
    const git = createGit(path);
    const isBare = await git.raw(['rev-parse', '--is-bare-repository']);
    return isBare.trim() === 'true';
  } catch {
    return false;
  }
}
```

**3.3 Migration tool: Convert remote to local**

If user already cloned a repo in `~/.agor/repos/` and later realizes they want to use their existing local copy:

```bash
# Convert remote repo to local
agor repo convert-to-local preset-io/agor --path ~/code/agor

# This would:
# 1. Update repo record (repo_type = 'local', local_path = ~/code/agor)
# 2. Optionally delete ~/.agor/repos/preset-io/agor
# 3. Preserve all worktrees (they continue to work)
```

---

## Migration Strategy

### For Existing Users

**Backward compatibility:** 100% - All existing repos are `repo_type = 'remote'`

**Migration script:**

```sql
-- Run during schema migration
UPDATE repos SET repo_type = 'remote' WHERE repo_type IS NULL;
```

**No breaking changes:**

- Existing repos continue to work
- Existing worktrees continue to work
- CLI commands unchanged (except new `add-local`)

### For New Users

**Discovery flow:**

1. User installs Agor
2. Runs `agor repo add-local ~/code/myapp` (instant onboarding)
3. Creates worktree: `agor worktree add myapp feat-auth`
4. Starts session in worktree

**Much faster than:**

1. User installs Agor
2. Finds git URL for their repo
3. Runs `agor repo add <url>` (waits for clone)
4. Creates worktree
5. Starts session

---

## Edge Cases & Considerations

### 1. User Deletes Local Repo

**Problem:** User deletes `~/code/myapp`, breaking Agor's reference.

**Detection:**

```typescript
// In worktree creation or session start
if (!(await fs.exists(repo.local_path))) {
  throw new Error(
    `Local repository not found: ${repo.local_path}\n` +
      `The repository may have been moved or deleted.`
  );
}
```

**Recovery:**

- User can update repo path: `agor repo update-path <slug> <new-path>`
- Or remove repo: `agor repo rm <slug>`

### 2. User Moves Local Repo

**Same as above** - provide `update-path` command:

```bash
agor repo update-path acme/myapp ~/new-location/myapp
```

### 3. User Force-Pushes or Rebases

**Impact:** Worktrees may reference commits that no longer exist in history.

**Agor's behavior:** Git will handle this gracefully:

- Worktree commits still exist (not garbage collected immediately)
- User can rebase/reset worktree to new history
- Same issue exists with remote repos (not unique to local)

**No special handling needed.**

### 4. Local Repo Has No Remote

**Supported** - User manages repo entirely locally.

**Implications:**

- `pullLatest` flag will fail gracefully (can't fetch)
- Remote operations in UI show "No remote configured"
- Otherwise works fine

### 5. Permissions & Access

**Local repos inherit file system permissions:**

- If user can read the repo, Agor can read it
- If user can write, Agor can create worktrees
- Multi-user systems: Be careful with shared repos

**Remote repos use git credentials:**

- SSH keys, GITHUB_TOKEN, etc.
- More explicit authentication

### 6. Monorepos with Submodules

**Git submodules work with worktrees:**

- Submodules are cloned per-worktree
- Each worktree can have different submodule versions

**No special handling needed** - git worktree handles this.

---

## Testing Strategy

### Unit Tests

**File:** `packages/core/src/git/index.test.ts`

```typescript
describe('Local repository support', () => {
  it('validates local git repository', async () => {
    const validPath = '/path/to/test/repo';
    const result = await isValidGitRepo(validPath);
    expect(result).toBe(true);
  });

  it('rejects non-git directory', async () => {
    const invalidPath = '/tmp/not-a-repo';
    const result = await isValidGitRepo(invalidPath);
    expect(result).toBe(false);
  });

  it('extracts remote URL from local repo', async () => {
    const path = '/path/to/test/repo';
    const remoteUrl = await getRemoteUrl(path);
    expect(remoteUrl).toBe('git@github.com:user/repo.git');
  });

  it('returns null for repo without remote', async () => {
    const path = '/path/to/local-only/repo';
    const remoteUrl = await getRemoteUrl(path);
    expect(remoteUrl).toBeNull();
  });
});
```

**File:** `packages/core/src/config/repo-reference.test.ts`

```typescript
describe('Local repo slug extraction', () => {
  it('uses explicit slug if provided', async () => {
    const slug = await extractLocalRepoSlug('/path/to/repo', 'custom/slug');
    expect(slug).toBe('custom/slug');
  });

  it('extracts slug from remote URL', async () => {
    // Mock getRemoteUrl to return GitHub URL
    const slug = await extractLocalRepoSlug('/path/to/repo');
    expect(slug).toBe('user/repo');
  });

  it('throws if no slug and no remote', async () => {
    // Mock getRemoteUrl to return null
    await expect(extractLocalRepoSlug('/path/to/repo')).rejects.toThrow(
      'Could not auto-detect slug'
    );
  });
});
```

### Integration Tests

**File:** `apps/agor-daemon/src/services/repos.test.ts`

```typescript
describe('ReposService - Local repos', () => {
  it('adds local repository with auto-detected slug', async () => {
    const repo = await reposService.addLocalRepository({
      path: '/test/repo',
    });

    expect(repo.repo_type).toBe('local');
    expect(repo.local_path).toBe('/test/repo');
    expect(repo.slug).toBe('user/repo'); // From mocked remote
  });

  it('adds local repository with explicit slug', async () => {
    const repo = await reposService.addLocalRepository({
      path: '/test/repo',
      slug: 'custom/name',
    });

    expect(repo.slug).toBe('custom/name');
  });

  it('rejects non-existent path', async () => {
    await expect(reposService.addLocalRepository({ path: '/nonexistent' })).rejects.toThrow(
      'Not a valid git repository'
    );
  });

  it('rejects duplicate slug', async () => {
    await reposService.addLocalRepository({
      path: '/test/repo1',
      slug: 'user/repo',
    });

    await expect(
      reposService.addLocalRepository({
        path: '/test/repo2',
        slug: 'user/repo',
      })
    ).rejects.toThrow('already exists');
  });
});
```

### Manual Testing Checklist

**Basic flow:**

- [ ] Add local repo with auto-detected slug
- [ ] Add local repo with explicit slug
- [ ] Create worktree from local repo
- [ ] Start session in worktree
- [ ] Verify base repo working tree untouched
- [ ] Create multiple worktrees from same local repo
- [ ] Delete worktree, verify base repo unchanged

**Edge cases:**

- [ ] Add local repo with no remote
- [ ] Add local repo with uncommitted changes
- [ ] Add local repo with custom remote name (not 'origin')
- [ ] Try to add non-git directory (should error)
- [ ] Try to add relative path (should error or resolve)
- [ ] Add bare repository

**Mixed repos:**

- [ ] List repos showing both remote and local types
- [ ] Create worktrees from both types in same session
- [ ] UI shows correct type/path for each

---

## Design Decisions

### 1. Path Handling ✓ DECIDED

**Decision:** Require absolute paths, but support `~/` for home directory expansion.

**Implementation:**

- Expand `~/` to user's home directory before validation
- After expansion, validate path is absolute
- Reject relative paths (e.g., `./myapp`, `../code/myapp`)

**Example:**

```bash
agor repo add-local ~/code/myapp          # ✓ Valid (expanded to /Users/max/code/myapp)
agor repo add-local /Users/max/code/myapp # ✓ Valid (absolute)
agor repo add-local ./myapp               # ✗ Invalid (relative)
```

### 2. Environment Config (.agor.yml) ✓ DECIDED

**Decision:** Re-parse `.agor.yml` on every repo load/worktree creation.

**Implementation:**

- Parse `.agor.yml` when adding local repo (store in database)
- Re-parse on worktree creation (use latest from user's repo)
- No file watching needed (simple, reliable)

**Rationale:**

- User manages their repo, changes should be picked up automatically
- Re-parsing on use is fast and simple
- Avoids complexity of file watching

### 3. Remote Accessibility Validation ✓ DECIDED

**Decision:** No additional validation needed beyond existing behavior.

**Current behavior:**

- Remote repos are validated by attempting `git clone` (fails if inaccessible)
- Local repos validate git repository structure only (no remote check)

**Rationale:**

- Remote validation for local repos happens naturally during worktree operations (`git fetch`)
- Matches existing mental model (fail at use time, not add time)
- Avoids slow/unreliable network checks during `repo add-local`

### 4. Repo Path Updates (Rename/Move) ✓ DECIDED

**Decision:** Provide `agor repo update-path` command to adjust pointer.

**Implementation:**

```bash
# User moves their repo
mv ~/code/myapp ~/projects/myapp

# Update Agor's pointer
agor repo update-path myapp ~/projects/myapp
```

**Failure handling:**

- If path becomes invalid, `git worktree` commands will fail naturally
- Pass git error messages to user (clear, actionable)
- No auto-detection or recovery needed

**Future enhancement:** Could detect invalid paths and suggest `update-path` command.

### 5. Default Branch Syncing ✓ DECIDED

**Decision:** Auto-fetch on worktree creation (same behavior as remote repos).

**Implementation:**

- When creating worktree with `pullLatest=true` (default), run `git fetch origin`
- Updates remote tracking branches in `.git/refs/remotes/`
- User's working tree remains untouched

**Rationale:**

- Consistent behavior between local and remote repos
- User expects latest code when creating worktree
- Safe operation (only updates git metadata)

---

## Security Considerations

### 1. Path Traversal

**Risk:** User provides malicious path (e.g., `../../etc`)

**Mitigation:**

- Support `~/` expansion for home directory
- After expansion, validate path is absolute
- Reject relative paths that could traverse outside expected directories
- Validate path is a git repository (prevents adding arbitrary directories)

### 2. Arbitrary Code Execution

**Risk:** User's repo contains malicious git hooks

**Mitigation:**

- Git hooks execute during worktree operations (same risk as remote repos)
- Document that users should trust repos they add to Agor
- Consider `core.hooksPath` config to disable hooks (heavy-handed)

**Recommendation:** Document risk, same as remote repos.

### 3. Multi-User Systems

**Risk:** User A adds repo owned by User B

**Mitigation:**

- File system permissions prevent access if not readable
- Sessions run as user who started daemon
- No special handling needed

---

## Documentation Updates

### 1. User Guide

**New section:** "Adding Repositories"

````markdown
## Adding Repositories

Agor supports two ways to add repositories:

### Remote Repositories (Clone from URL)

Add a repository by cloning from a remote URL:

```bash
# GitHub (HTTPS)
agor repo add https://github.com/user/repo.git

# GitHub (SSH)
agor repo add git@github.com:user/repo.git

# Custom slug
agor repo add https://github.com/user/repo.git --slug my/custom-name
```
````

Agor will clone the repository to `~/.agor/repos/{slug}/`.

### Local Repositories (Use Existing Clone)

Add an existing local repository:

```bash
# Auto-detect slug from git remote
agor repo add-local ~/code/myapp

# Provide explicit slug
agor repo add-local ~/code/myapp --slug company/myapp
```

Agor will use your existing repository without copying it.

**Safety:** Agor never modifies the working tree of local repositories.
Only metadata in `.git/` is updated (remote tracking branches, etc.).

````

### 2. Architecture Docs

Update `context/concepts/worktrees.md`:

```markdown
## Repository Types

Agor supports two repository types:

- **Remote:** Cloned from a git URL into `~/.agor/repos/`
- **Local:** References an existing local repository at a user-provided path

Both types support the same worktree operations and environment configurations.
````

### 3. API Docs

Document new endpoint:

```
POST /repos/local
  Add a local repository

  Body:
    path: string      - Absolute path to git repository
    slug?: string     - Optional explicit slug

  Returns: Repo
```

---

## Success Metrics

**Adoption:**

- % of users who add local repos vs remote repos
- Average time to first worktree (expect faster with local repos)

**Reliability:**

- Error rate for local repo operations
- Support tickets related to local repo issues

**Performance:**

- Time to add local repo vs clone remote repo
- Disk space savings (estimate based on repo sizes)

---

## Summary

**What:** Enable Agor to work with existing local git repositories without cloning.

**Why:** Better UX, faster onboarding, disk space efficiency, matches user mental model.

**How:** Add `repo_type` field, new `addLocalRepository()` service method, new `repo add-local` CLI command.

**Safety:** Git worktree mechanism ensures base repo working tree is never modified.

**Backward compatibility:** 100% - existing repos unaffected.

**Implementation effort:** ~2-3 days for Phase 1 (core support).

**Key files:**

- `packages/core/src/types/repo.ts` - Add repo_type
- `packages/core/src/git/index.ts` - Validation utilities (isValidGitRepo, getRemoteUrl)
- `packages/core/src/config/repo-reference.ts` - Slug extraction (extractLocalRepoSlug)
- `apps/agor-daemon/src/services/repos.ts` - Service logic (addLocalRepository)
- `apps/agor-cli/src/commands/repo/add-local.ts` - New CLI command

**Design decisions:** All key decisions finalized (see "Design Decisions" section).

- ✓ Path handling: Absolute paths with `~/` expansion support
- ✓ Environment config: Re-parse .agor.yml on load
- ✓ Remote validation: No additional checks (handled by git operations)
- ✓ Repo moves: Provide update-path command, let git fail naturally
- ✓ Branch syncing: Auto-fetch on worktree creation

**Next steps:** Implement Phase 1 (core support), test with real repos, iterate on UX.
