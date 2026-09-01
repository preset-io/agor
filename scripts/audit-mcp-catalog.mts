/** Scheduled, read-only audit of curated hosted MCP endpoints. */
import { appendFile, readFile } from 'node:fs/promises';
import { parseCuratedCatalog } from '../packages/core/src/mcp-catalog/curated-loader.ts';
import { auditCatalogHealth } from '../packages/core/src/mcp-catalog/index.ts';

const catalogSource = await readFile(
  new URL('../packages/core/src/mcp-catalog/curated.yaml', import.meta.url),
  'utf8'
);
const results = await auditCatalogHealth(parseCuratedCatalog(catalogSource));
const unhealthy = results.filter(({ status }) => status !== 'ready');

for (const result of results) {
  const line =
    `[mcp-catalog/audit] entry=${result.name} status=${result.status}` +
    ` expected_auth=${result.expectedAuth} observed_auth=${result.observedAuth}` +
    (result.reason ? ` reason=${result.reason}` : '');
  if (result.status === 'ready') console.log(line);
  else console.warn(line);
}

const summary = [
  '## MCP catalog health audit',
  '',
  `Checked ${results.length} entries; ${results.length - unhealthy.length} ready; ${unhealthy.length} warnings.`,
  '',
  '| Entry | Status | Expected | Observed | Reason |',
  '| --- | --- | --- | --- | --- |',
  ...unhealthy.map(
    (item) =>
      `| \`${item.name}\` | ${item.status} | ${item.expectedAuth} | ${item.observedAuth} | ${item.reason ?? ''} |`
  ),
  '',
  '> Vendor reachability and metadata drift are warnings: an external outage never fails ordinary PR CI.',
].join('\n');

const summaryFlag = process.argv.indexOf('--summary-file');
const summaryFile = summaryFlag >= 0 ? process.argv[summaryFlag + 1] : undefined;
if (summaryFile) {
  await appendFile(summaryFile, `${summary}\n`);
}
console.log(`[mcp-catalog/audit] complete total=${results.length} warnings=${unhealthy.length}`);
