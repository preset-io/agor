// Design-only synthetic probe for #2640, NOT application/runtime implementation.
// Copy to a disposable directory with the dependencies documented in the design note.
// No HTTP server, Agor API, customer app, secret, or existing browser profile is used.
// Wrap already-published CommonJS files for the browser; do not compile Agor.
// Results contain network/body excerpts: use ONLY the checked-in synthetic cases.
const fs = require('fs'),
  path = require('path'),
  { createRequire } = require('module');
const { chromium } = require('playwright');
const root = __dirname,
  modules = {},
  ids = new Map();
function add(file) {
  if (ids.has(file)) return ids.get(file);
  const id = ids.size;
  ids.set(file, id);
  let code = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) code = 'module.exports=' + code;
  const req = createRequire(file),
    deps = {};
  modules[id] = { code, deps };
  for (const m of code.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
    try {
      const f = req.resolve(m[1]);
      if (path.isAbsolute(f)) deps[m[1]] = add(f);
    } catch {}
  }
  return id;
}
const react = add(require.resolve('react')),
  dom = add(require.resolve('react-dom/client')),
  sand = add(require.resolve('@codesandbox/sandpack-react'));
const bundle = `const process={env:{NODE_ENV:'production'}};const mods={${Object.entries(modules)
  .map(
    ([i, m]) => `${i}:[function(require,module,exports){\n${m.code}\n},${JSON.stringify(m.deps)}]`
  )
  .join(
    ','
  )}};const cache={};function R(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};mods[id][0](n=>{if(!(n in mods[id][1]))throw Error('Missing require '+n);return R(mods[id][1][n])},m,m.exports);return m.exports;}window.React=R(${react});window.createRoot=R(${dom}).createRoot;window.SP=R(${sand});`;
const init = `window.events=[];window.addEventListener('message',e=>{if(e.data?.type)window.events.push(e.data)});const h=React.createElement;window.run=(c)=>{window.config=c;function Report(){const {sandpack}=SP.useSandpack();window.state={status:sandpack.status,error:sandpack.error,environment:sandpack.environment,files:Object.keys(sandpack.files)};return null};createRoot(document.getElementById('root')).render(h(SP.SandpackProvider,{template:c.template,files:c.files||{},customSetup:c.customSetup,options:{initMode:'immediate',...c.options}},h(SP.SandpackPreview,{showOpenInCodeSandbox:false}),h(Report)));};`;
(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    console.log('browser', browser.version());
    const configs = JSON.parse(fs.readFileSync(process.argv[2] || root + '/cases.json', 'utf8'));
    for (const c of configs) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const network = [],
        errors = [];
      page.on('response', async (r) => {
        if (!r.url().startsWith('https://probe.invalid')) {
          const item = { url: r.url(), status: r.status(), type: r.headers()['content-type'] };
          if (r.request().resourceType() === 'fetch' || r.status() >= 400) {
            try {
              item.prefix = (await r.text()).slice(0, 180);
            } catch {}
          }
          network.push(item);
        }
      });
      page.on('requestfailed', (r) =>
        network.push({ url: r.url(), failure: r.failure()?.errorText })
      );
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text().slice(0, 500));
      });
      for (const faultUrl of c.faultUrls || [c.faultUrl].filter(Boolean))
        await page.route(faultUrl, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html',
            headers: { 'access-control-allow-origin': '*' },
            body: '<!doctype html><html><body>SYNTHETIC_GATEWAY_ERROR</body></html>',
          })
        );
      await page.route('https://probe.invalid/**', async (route) => {
        const u = route.request().url();
        await route.fulfill({
          headers: !u.endsWith('.js') && c.csp ? { 'content-security-policy': c.csp } : {},
          contentType: u.endsWith('.js') ? 'application/javascript' : 'text/html',
          body: u.endsWith('bundle.js')
            ? bundle
            : u.endsWith('init.js')
              ? init
              : '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script><script src="/init.js"></script></body></html>',
        });
      });
      await page.goto('https://probe.invalid/');
      await page.evaluate((c) => window.run(c), c);
      await page.waitForTimeout(c.waitMs || 18000);
      const state = await page.evaluate(() => ({
        state: window.state,
        events: window.events.filter((e) => /error|status|done|start/.test(e.type)).slice(-15),
      }));
      const frames = [];
      for (const f of page.frames()) {
        try {
          frames.push({
            url: f.url(),
            text: (await f.locator('body').innerText({ timeout: 1000 })).slice(0, 1800),
          });
        } catch {}
      }
      const result = { name: c.name, config: c, ...state, frames, errors, network };
      fs.writeFileSync(root + '/' + c.name + '.json', JSON.stringify(result, null, 2));
      console.log(
        JSON.stringify({
          name: c.name,
          ...state,
          frames,
          errors,
          network: network.filter((n) => n.failure || n.status >= 400 || n.prefix),
        })
      );
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
