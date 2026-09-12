// Run in the release image on EC2/XFS; no fallback to byte copies is allowed.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { createBranchAsReflink, createGit } = await import(
  '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/git/index.js'
);
const root = await mkdtemp('/proof/reflink-');
try {
  const base = {
    remoteUrl: 'https://github.com/apache/superset.git',
    referencePath: '/home/agor/.agor/repos/apache/superset',
    cacheRoot: path.join(root, 'cache'),
    cacheScope: 'superset-proof',
    ref: 'master',
  };
  const durations = [];
  for (const name of ['first', 'second']) {
    const started = performance.now();
    await createBranchAsReflink({
      ...base,
      targetPath: path.join(root, name),
      newBranchName: `proof/${name}`,
    });
    durations.push(Math.round(performance.now() - started));
  }
  // Reproduce the actual UI history-depth transition, then deepen and return
  // to full history. Every checkout must have correct Git shallow semantics.
  const depthDurations = {};
  for (const depth of [100, 200]) {
    const targetPath = path.join(root, `depth-${depth}`);
    const started = performance.now();
    await createBranchAsReflink({ ...base, depth, targetPath });
    depthDurations[depth] = Math.round(performance.now() - started);
    const git = createGit(targetPath).git;
    assert.equal((await git.raw(['rev-parse', '--is-shallow-repository'])).trim(), 'true');
    assert.equal(
      Number((await git.raw(['rev-list', '--first-parent', '--count', 'HEAD'])).trim()) > 0,
      true
    );
    assert((await git.status()).isClean());
    assert.equal(
      (await git.revparse(['HEAD'])).trim(),
      (await createGit(path.join(root, 'first')).git.revparse(['HEAD'])).trim()
    );
  }
  console.log(JSON.stringify({ depthDurations }));
  const a = path.join(root, 'first'),
    b = path.join(root, 'second');
  const ga = createGit(a).git,
    gb = createGit(b).git;
  assert((await ga.status()).isClean());
  assert((await gb.status()).isClean());
  assert.equal((await gb.raw(['symbolic-ref', '--short', 'HEAD'])).trim(), 'proof/second');
  assert.notEqual(
    (await stat(path.join(a, '.git/index'))).ino,
    (await stat(path.join(b, '.git/index'))).ino
  );
  const original = await readFile(path.join(b, 'README.md'), 'utf8');
  await writeFile(path.join(a, 'README.md'), 'isolated proof modification');
  await ga.add('README.md');
  assert.equal(await readFile(path.join(b, 'README.md'), 'utf8'), original);
  assert((await gb.status()).isClean());
  await gb.raw(['log', '-1', '--format=%H']);
  console.log(
    JSON.stringify({
      reflinkProof: true,
      coldMs: durations[0],
      warmMs: durations[1],
      privateGit: true,
      siblingIsolation: true,
    })
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
