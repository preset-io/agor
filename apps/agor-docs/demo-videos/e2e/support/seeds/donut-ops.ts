// The Donut Shop's back office and OpsBot, its operations teammate, with the
// shop's real demo history (fixtures/data/donut-shop, exported from the
// DonutShop MotherDuck database) as a local DuckDB file in OpsBot's branch.

import { buildDonutShopWarehouse } from '../fixtures.ts';
import type { SeedDef } from '../seeds.ts';

const OPSBOT = `You are OpsBot, the Donut Shop's operations teammate. You watch the
numbers so the owner doesn't have to dig.

## Your data

The shop's database is DuckDB at \`data/donut_shop.duckdb\`
(\`duckdb data/donut_shop.duckdb -c "..."\`). Money is in cents.
- \`orders\` (placed_at, channel: web / pos / wholesale, status, subtotal_cents,
  fee_cents, total_cents, customer_id), \`order_items\`, \`payments\`,
  \`customers\`, \`subscriptions\`, plus the catalog (\`doughs\`, \`frostings\`,
  \`toppings\`) and inventory tables.

## How you answer "how are sales doing?"

1. Query the period asked for and the period before it.
2. Answer with one compact markdown table: revenue, orders, average order
   value, and the split by channel, this period vs the last, with % change.
3. Two or three short takeaways in plain words (what moved and why).
4. Offer to turn it into a live dashboard on the board as an Agor artifact
   (a chart of weekly revenue by channel). Don't build it unless asked.`;

const USER = `- **Name:** Sam Rivera
- **What to call them:** Sam
- **Role:** Owner of the Donut Shop

## Sharing and action preferences

- **Style:** plain words, numbers first, no jargon.`;

export const donutOps: SeedDef = {
  name: 'donut-ops',
  extends: 'workspace',
  description:
    "The Donut Shop's back office: a board with OpsBot, the operations teammate, and six months of the shop's sales in a local DuckDB.",
  inputs: ['support/seeds/donut-ops.ts', 'fixtures/data/donut-shop'],
  async run(s) {
    await s.board('shop', {
      title: 'Donut Shop HQ',
      icon: '🍩',
      description: 'Storefront, back office, and the daily specials.',
      zones: {
        teammates: { label: 'AI teammates', x: 0, y: 0, width: 560, height: 520, color: '#722ed1' },
      },
    });
    const opsbot = await s.teammate('opsbot', {
      board: 'shop',
      zone: 'teammates',
      at: { x: 30, y: 70 },
      displayName: 'OpsBot',
      emoji: '📈',
      description: 'Operations: sales, inventory and the daily numbers.',
      primary: true,
      identity: OPSBOT,
      user: USER,
      files: { '.gitignore': 'data/\n' },
    });
    buildDonutShopWarehouse(`${opsbot.dir}/data/donut_shop.duckdb`);
    await s.session('ask-opsbot', { branch: 'opsbot' });
  },
};
