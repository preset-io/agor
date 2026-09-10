import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BIN = process.argv[2];
const ROOT = process.argv[3];
rmSync(ROOT, { recursive: true, force: true });
const home = join(ROOT, 'home');
const dbdir = join(ROOT, 'dbdir');
const work = join(ROOT, 'work');
for (const d of [home, dbdir, work]) mkdirSync(d, { recursive: true });
execFileSync('git', ['init', '-q', work]);
writeFileSync(join(work, 'README.md'), 'hi\n');
const PASS = 'spike-password';
const dbFile = join(dbdir, 'opencode.db');
const env = () => ({
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: join(home, 'data'),
  XDG_CONFIG_HOME: join(home, 'xdg-config'),
  XDG_CACHE_HOME: join(home, 'xdg-cache'),
  XDG_STATE_HOME: join(home, 'xdg-state'),
  OPENCODE_SERVER_USERNAME: 'agor',
  OPENCODE_SERVER_PASSWORD: PASS,
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_PRUNE: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  OPENCODE_DB: dbFile,
});
const AUTH = 'Basic ' + Buffer.from(`agor:${PASS}`).toString('base64');
async function start() {
  const t0 = Date.now();
  const child = spawn(BIN, ['serve', '--hostname=127.0.0.1', '--port=0'], {
    env: env(),
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const url = await new Promise((res, rej) => {
    const on = (c) => {
      out += c;
      const m = out.match(/listening on (http:\/\/[^\s]+)/);
      if (m) res(m[1]);
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', (c) => rej(new Error('exited ' + c + out)));
    setTimeout(() => rej(new Error('timeout' + out)), 20000);
  });
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(url + '/global/health', { headers: { Authorization: AUTH } });
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, url, ms: Date.now() - t0 };
}
const api = (url, method, path, body) =>
  fetch(url + path, {
    method,
    headers: { Authorization: AUTH, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const q = (f, sql = 'select count(*) from session;') => {
  try {
    return execFileSync('sqlite3', [f, sql]).toString().trim();
  } catch (e) {
    return 'ERR ' + e.message.split('\n')[0];
  }
};
const dir = encodeURIComponent(work);
// A: two concurrent servers on one OPENCODE_DB (local FS): does SQLite fence a second writer?
const a = await start();
const b = await start();
console.log('A startup ms:', a.ms, b.ms);
const sa = await api(a.url, 'POST', `/session?directory=${dir}`, { title: 'from-a' });
const sb = await api(b.url, 'POST', `/session?directory=${dir}`, { title: 'from-b' });
console.log('A create via server A:', sa.status, 'via server B:', sb.status, 'rows:', q(dbFile));
const cross = await api(a.url, 'GET', `/session/${sb.json?.id}?directory=${dir}`);
console.log('A server A sees B session:', cross.status);
b.child.kill('SIGKILL');
await new Promise((r) => b.child.on('exit', r));
// B: checkpoint-publish: close server A cleanly, TRUNCATE-checkpoint, then copy ONLY main file.
a.child.kill('SIGTERM');
await new Promise((r) => a.child.on('exit', r));
console.log(
  'B sizes after close: db',
  statSync(dbFile).size,
  'wal',
  existsSync(dbFile + '-wal') ? statSync(dbFile + '-wal').size : 'absent'
);
console.log('B checkpoint:', q(dbFile, 'PRAGMA wal_checkpoint(TRUNCATE);'));
console.log(
  'B sizes after checkpoint: db',
  statSync(dbFile).size,
  'wal',
  existsSync(dbFile + '-wal') ? statSync(dbFile + '-wal').size : 'absent'
);
const pub = join(ROOT, 'published.db');
copyFileSync(dbFile, pub);
console.log(
  'B rows in main-only copy after checkpoint:',
  q(pub),
  'integrity:',
  q(pub, 'PRAGMA integrity_check;')
);
// C: resume from the published single file in a fresh location (simulates copy-in to emptyDir)
const fresh = join(ROOT, 'fresh');
mkdirSync(fresh);
copyFileSync(pub, join(fresh, 'opencode.db'));
process.env.OPENCODE_DB = join(fresh, 'opencode.db');
const c = await start();
const got = await api(c.url, 'GET', `/session/${sa.json.id}?directory=${dir}`);
console.log(
  'C resume from published copy:',
  got.status,
  got.json?.id === sa.json.id ? 'MATCH' : 'MISMATCH'
);
c.child.kill('SIGTERM');
await new Promise((r) => c.child.on('exit', r));
