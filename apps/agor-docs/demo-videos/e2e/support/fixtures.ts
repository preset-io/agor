// Filesystem fixtures for seeds: the fictional companies' git repos,
// their analytics warehouses, and the GitHub and Jira stand-ins' data.
// Everything is built from committed material in fixtures/, so anyone can
// change a dataset or a repo and reseed.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FAKE_GITHUB_DIR,
  FAKE_JIRA_DIR,
  FIXTURES_DIR,
  PROJECTS_DIR,
  SCRATCH_DIR,
} from './harness.ts';

const REMOTES_DIR = path.join(SCRATCH_DIR, 'remotes');

function run(cmd: string, args: string[], cwd: string, input?: string): string {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', input });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

const git = (cwd: string, args: string[]) =>
  run('git', ['-c', 'user.name=Agor Demo', '-c', 'user.email=demo@agor.live', ...args], cwd);

/**
 * Point a clone's GitHub-looking origin at a local bare repo, so pushes and
 * fetches work offline while `git remote -v` (and the gh stand-in) still
 * see github.com/<owner>/<repo>.
 */
export function routeGithubRemote(dir: string, github: string): void {
  const bare = path.join(REMOTES_DIR, `${github.replace('/', '__')}.git`);
  git(dir, ['config', `url.${bare}.insteadOf`, `https://github.com/${github}.git`]);
  // git reports the rewritten (local) URL, so tell the gh stand-in directly.
  git(dir, ['config', 'demo.github-repo', github]);
}

/**
 * Create a fictional company's repo from fixtures/repos/<template>: a fresh
 * git history, a local bare "GitHub" remote, and `main` pushed to it.
 * Returns the working clone's path.
 */
export function localRepo(template: string, github: string): string {
  const src = path.join(FIXTURES_DIR, 'repos', template);
  if (!existsSync(src)) throw new Error(`no fixture repo ${template} in ${path.dirname(src)}`);
  const dir = path.join(PROJECTS_DIR, template);
  const bare = path.join(REMOTES_DIR, `${github.replace('/', '__')}.git`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  mkdirSync(REMOTES_DIR, { recursive: true });
  cpSync(src, dir, { recursive: true });
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'Initial import']);
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare], REMOTES_DIR);
  git(dir, ['remote', 'add', 'origin', `https://github.com/${github}.git`]);
  routeGithubRemote(dir, github);
  git(dir, ['push', '--quiet', '-u', 'origin', 'main']);
  return dir;
}

/** Clone a fictional repo (made by localRepo) into `dest`, origin routed the same way. */
export function cloneInto(github: string, dest: string): void {
  const bare = path.join(REMOTES_DIR, `${github.replace('/', '__')}.git`);
  rmSync(dest, { recursive: true, force: true });
  run('git', ['clone', '--quiet', bare, dest], path.dirname(dest));
  git(dest, ['remote', 'set-url', 'origin', `https://github.com/${github}.git`]);
  routeGithubRemote(dest, github);
}

export interface FakePull {
  number: number;
  title: string;
  head: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  draft?: boolean;
  /** Days before today. */
  ageDays: number;
  body?: string;
  reviewers?: string[];
  reviews?: { by: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' }[];
  additions?: number;
  deletions?: number;
  labels?: string[];
}

export interface FakeIssue {
  number: number;
  title: string;
  author: string;
  /** Days before today. */
  ageDays: number;
  state?: 'open' | 'closed';
  body?: string;
  assignees?: string[];
  labels?: string[];
  comments?: number;
}

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** Seed the GitHub stand-in with a repo's pull requests (and issues). */
export function fakeGithub(
  github: string,
  description: string,
  pulls: FakePull[],
  issues: FakeIssue[] = []
): void {
  mkdirSync(FAKE_GITHUB_DIR, { recursive: true });
  const data = {
    description,
    // PRs and issues share GitHub's numbering.
    next: Math.max(100, ...pulls.map((p) => p.number), ...issues.map((i) => i.number)) + 1,
    pulls: pulls.map(({ ageDays, ...p }) => ({
      ...p,
      createdAt: daysAgo(ageDays),
      updatedAt: daysAgo(ageDays),
    })),
    issues: issues.map(({ ageDays, ...i }) => ({ ...i, createdAt: daysAgo(ageDays) })),
  };
  writeFileSync(
    path.join(FAKE_GITHUB_DIR, `${github.replace('/', '__')}.json`),
    `${JSON.stringify(data, null, 2)}\n`
  );
}

export interface FakeTicket {
  /** e.g. SAASY-431 */
  key: string;
  summary: string;
  type: 'Bug' | 'Story' | 'Task';
  status: string;
  priority: 'Highest' | 'High' | 'Medium' | 'Low';
  /** Email of the assignee (a key of the project's people), if any. */
  assignee?: string;
  reporter: string;
  /** Days before today. */
  ageDays: number;
  labels?: string[];
  description?: string;
}

/** Seed the Jira stand-in (fixtures/bin/jira) with a project and its tickets. */
export function fakeJira(project: {
  key: string;
  name: string;
  lead: string;
  statuses: string[];
  /** Email to display name. */
  people: Record<string, string>;
  tickets: FakeTicket[];
}): void {
  mkdirSync(FAKE_JIRA_DIR, { recursive: true });
  const { tickets, ...rest } = project;
  const data = {
    ...rest,
    issues: tickets.map(({ ageDays, ...t }) => ({
      ...t,
      assigneeName: t.assignee ? project.people[t.assignee] : undefined,
      reporterName: project.people[t.reporter] ?? t.reporter,
      createdAt: daysAgo(ageDays),
    })),
  };
  writeFileSync(
    path.join(FAKE_JIRA_DIR, `${project.key}.json`),
    `${JSON.stringify(data, null, 2)}\n`
  );
}

/** SaaSy Co.'s warehouse (fixtures/data/saasy/build.sql), 13 months ending today. */
export function buildSaasyWarehouse(dest: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  const sql = readFileSync(path.join(FIXTURES_DIR, 'data', 'saasy', 'build.sql'), 'utf8');
  run('duckdb', [dest], path.dirname(dest), sql);
}

/**
 * The Donut Shop's database from its Parquet export
 * (fixtures/data/donut-shop), with every date moved forward so the last
 * full day of trade is yesterday: "the last 90 days" is always full, with no
 * gap a sharp agent would flag. (The weekly closed day moves with it.)
 */
export function buildDonutShopWarehouse(dest: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  const src = path.join(FIXTURES_DIR, 'data', 'donut-shop');
  run('duckdb', [dest, '-c', `IMPORT DATABASE '${src}'`], path.dirname(dest));
  const cols = run(
    'duckdb',
    [
      dest,
      '-csv',
      '-noheader',
      '-c',
      "SELECT c.table_name, c.column_name FROM duckdb_columns() c JOIN duckdb_tables() t USING (database_name, schema_name, table_name) WHERE c.database_name = current_database() AND (c.data_type = 'DATE' OR c.data_type LIKE 'TIMESTAMP%')",
    ],
    path.dirname(dest)
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(','));
  // The export's history is dense through its last full trading day; a few
  // stray orders from later app testing sit days past it and read as a
  // data gap. Anchor on the last day with a real day's trade (20+ orders)
  // and drop anything after it.
  const trim = `
    SET VARIABLE anchor = (SELECT max(d) FROM (SELECT placed_at::DATE d FROM orders GROUP BY 1 HAVING count(*) >= 20));
    DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE placed_at::DATE > getvariable('anchor'));
    DELETE FROM reviews WHERE order_id IN (SELECT id FROM orders WHERE placed_at::DATE > getvariable('anchor'));
    DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE placed_at::DATE > getvariable('anchor'));
    DELETE FROM orders WHERE placed_at::DATE > getvariable('anchor');`;
  run('duckdb', [dest], path.dirname(dest), trim);
  // Computed once, from the trimmed orders table, before any update runs.
  const setShift =
    "SET VARIABLE shift_days = (SELECT datediff('day', max(placed_at)::DATE, current_date - 1) FROM orders);";
  const updates = cols.map(
    ([t, c]) => `UPDATE "${t}" SET "${c}" = "${c}" + to_days(getvariable('shift_days'));`
  );
  run('duckdb', [dest], path.dirname(dest), [setShift, ...updates].join('\n'));
}
