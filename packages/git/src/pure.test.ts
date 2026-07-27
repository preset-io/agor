import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getBranchPath, getDataHomeRoot, getReposDir, setDataHomeTenantResolver } from './pure';

const BASE = '/data/agor';

describe('tenant-aware data home', () => {
  let prevDataHome: string | undefined;

  beforeAll(() => {
    prevDataHome = process.env.AGOR_DATA_HOME;
    process.env.AGOR_DATA_HOME = BASE;
  });

  afterEach(() => {
    setDataHomeTenantResolver(undefined);
  });

  afterAll(() => {
    if (prevDataHome === undefined) delete process.env.AGOR_DATA_HOME;
    else process.env.AGOR_DATA_HOME = prevDataHome;
  });

  it('uses the un-scoped root when no resolver is set (executor / OSS default)', () => {
    expect(getDataHomeRoot()).toBe(BASE);
    expect(getReposDir()).toBe(`${BASE}/repos`);
    expect(getBranchPath('preset-io/agor', 'feat-x')).toBe(
      `${BASE}/worktrees/preset-io/agor/feat-x`
    );
  });

  it('stays un-scoped for the default tenant (zero migration for static installs)', () => {
    setDataHomeTenantResolver(() => 'default');
    expect(getReposDir()).toBe(`${BASE}/repos`);
    // getDataHomeRoot never carries a tenant segment — the executor delete safety
    // checks depend on it staying the shared root.
    expect(getDataHomeRoot()).toBe(BASE);
  });

  it('nests under tenants/<id> for a resolved non-default tenant', () => {
    setDataHomeTenantResolver(() => 'ws_abc123');
    expect(getReposDir()).toBe(`${BASE}/tenants/ws_abc123/repos`);
    expect(getBranchPath('preset-io/agor', 'feat-x')).toBe(
      `${BASE}/tenants/ws_abc123/worktrees/preset-io/agor/feat-x`
    );
    // A tenant-scoped path is still contained by the un-scoped root, so the
    // executor's containment check passes without ambient tenant context.
    expect(getReposDir().startsWith(`${getDataHomeRoot()}/`)).toBe(true);
  });
});
