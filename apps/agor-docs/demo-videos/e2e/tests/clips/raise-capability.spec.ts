// Clip: raise-capability (support/clips.ts). Agents with capability: the
// MCP Catalog, then wiring up a server by hand.

import { smoothWheel } from '../../support/raise.ts';
import { clip } from '../../support/studio.ts';

clip('raise-capability', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true, cursor: false });
  const p = sam.page;
  p.setDefaultTimeout(20_000);
  await sam.open('/');
  await studio.action();

  studio.mark('catalog');
  await sam.click(p.getByLabel('Open MCP Catalog').first());
  await sam.hold(900);
  await sam.sweep(
    ['GitHub', 'Linear', 'Sentry', 'Notion'].map((name) => p.getByLabel(`Open ${name}`).first()),
    1600
  );
  await smoothWheel(sam, 1560, 2000);
  await sam.hold(600);
  await sam.press('Escape');

  // Wire one up: Linear, over HTTP with OAuth.
  await sam.open('/settings/mcp');
  studio.mark('configure');
  await sam.click(p.getByRole('button', { name: /New MCP Server/ }).first());
  await sam.hold(700);
  await sam.type(p.getByPlaceholder('context7', { exact: true }), 'linear');
  await sam.type(p.getByPlaceholder('Context7 MCP', { exact: true }), 'Linear');
  await sam.type(
    p.getByPlaceholder('Optional description...', { exact: true }),
    'Issues and projects for the eng team.'
  );
  await sam.click(p.getByLabel('Transport'));
  await sam.click(
    p
      .locator('.ant-select-item-option')
      .filter({ hasText: /^HTTP$/ })
      .first()
  );
  await sam.hold(400);
  await sam.type(
    p.getByPlaceholder('https://mcp.example.com', { exact: true }),
    'https://mcp.linear.app/mcp'
  );
  await sam.click(p.getByLabel('Auth Type'));
  await sam.click(p.locator('.ant-select-item-option').filter({ hasText: 'OAuth 2.1' }).first());
  studio.mark('filled');
  await sam.hold(1500);
});
