// Local, credential-free OpenCode 1.14.33 storage spike (task-owned, disposable).
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
const dataHome = join(home, 'data');
const env = (extra = {}) => ({
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: dataHome,
  XDG_CONFIG_HOME: join(home, 'xdg-config'),
  XDG_CACHE_HOME: join(home, 'xdg-cache'),
  XDG_STATE_HOME: join(home, 'xdg-state'),
  OPENCODE_SERVER_USERNAME: 'agor',
  OPENCODE_SERVER_PASSWORD: PASS,
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_PRUNE: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  ...extra,
});
const AUTH = 'Basic ' + Buffer.from(`agor:${PASS}`).toString('base64');
function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(`${p.slice(base.length + 1)} (${statSync(p).size}b)`);
  }
  return out;
}
async function start(extra) {
  const child = spawn(BIN, ['serve', '--hostname=127.0.0.1', '--port=0'], {
    env: env(extra),
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const url = await new Promise((resolve, reject) => {
    const on = (c) => {
      out += c;
      const m = out.match(/opencode server listening on (http:\/\/[^\s]+)/);
      if (m) resolve(m[1]);
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', (c) => reject(new Error('exited ' + c + '\n' + out)));
    setTimeout(() => reject(new Error('timeout\n' + out)), 20000);
  });
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(url + '/global/health', { headers: { Authorization: AUTH } });
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, url, startupOutput: () => out };
}
const api = (url, method, path, body) =>
  fetch(url + path, {
    method,
    headers: { Authorization: AUTH, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const dbFile = join(dbdir, 'opencode.db');
const log = (...a) => console.log(...a);

// Phase 1: serve with OPENCODE_DB outside XDG data home; create session; write API key; SIGKILL.
let s = await start({ OPENCODE_DB: dbFile });
log('P1 startup output:', JSON.stringify(s.startupOutput().slice(0, 300)));
const created = await api(s.url, 'POST', `/session?directory=${encodeURIComponent(work)}`, {
  title: 'spike',
});
log('P1 session create:', created.status, created.json?.id);
const authSet = await api(s.url, 'PUT', '/auth/anthropic', {
  type: 'api',
  key: 'sk-spike-not-a-real-key',
});
log('P1 auth.set:', authSet.status, authSet.json);
const sid = created.json.id;
log('P1 inventory home:', walk(home));
log('P1 inventory dbdir:', walk(dbdir));
s.child.kill('SIGKILL');
await new Promise((r) => s.child.on('exit', r));
log('P1 after SIGKILL dbdir:', walk(dbdir));

// Phase 2: copy ONLY the main db file (no -wal) and inspect with sqlite3.
const copyOnly = join(ROOT, 'copy-main-only.db');
copyFileSync(dbFile, copyOnly);
const q = (f) => {
  try {
    return execFileSync('sqlite3', [f, 'select count(*) from session;']).toString().trim();
  } catch (e) {
    return 'ERR ' + e.message.split('\n')[0];
  }
};
log('P2 session rows in main-only copy:', q(copyOnly));
const copyBoth = join(ROOT, 'copy-both.db');
copyFileSync(dbFile, copyBoth);
if (existsSync(dbFile + '-wal')) copyFileSync(dbFile + '-wal', copyBoth + '-wal');
log('P2 session rows in db+wal copy:', q(copyBoth));
log('P2 session rows in live file (sqlite3 opens wal):', q(dbFile));

// Phase 3: restart same env after SIGKILL and resume the session.
s = await start({ OPENCODE_DB: dbFile });
log('P3 startup output:', JSON.stringify(s.startupOutput().slice(0, 300)));
const got = await api(s.url, 'GET', `/session/${sid}?directory=${encodeURIComponent(work)}`);
log(
  'P3 session.get after SIGKILL restart:',
  got.status,
  got.json?.id === sid ? 'MATCH' : JSON.stringify(got.json).slice(0, 200)
);
const wrong = await api(
  s.url,
  'GET',
  `/session/ses_doesnotexist?directory=${encodeURIComponent(work)}`
);
log('P3 wrong session id:', wrong.status);
s.child.kill('SIGTERM');
await new Promise((r) => s.child.on('exit', r));
log('P3 after SIGTERM dbdir:', walk(dbdir));
log(
  'P3 auth.json present under XDG data home:',
  existsSync(join(dataHome, 'opencode', 'auth.json'))
);

// Phase 4: restart WITHOUT OPENCODE_DB → does it see the session? (proves DB placement, not shared)
s = await start({});
const got2 = await api(s.url, 'GET', `/session/${sid}?directory=${encodeURIComponent(work)}`);
log('P4 session.get with default DB path:', got2.status);
log('P4 inventory data home:', walk(dataHome));
s.child.kill('SIGTERM');
await new Promise((r) => s.child.on('exit', r));
