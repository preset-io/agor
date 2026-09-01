/** Scheduled and curation-PR audit of curated hosted MCP endpoints. */
import { appendFile, readFile } from 'node:fs/promises';
import { parseCuratedCatalog } from '../packages/core/src/mcp-catalog/curated-loader.ts';
import {
  auditCatalogHealth,
  type CatalogHealthResult,
} from '../packages/core/src/mcp-catalog/index.ts';

const catalogSource = await readFile(
  new URL('../packages/core/src/mcp-catalog/curated.yaml', import.meta.url),
  'utf8'
);
const results = await auditCatalogHealth(parseCuratedCatalog(catalogSource));

const actionable = results.filter(({ status }) =>
  ['auth-drift', 'oauth-metadata-not-ready', 'oauth-now-available'].includes(status)
);
const advisory = results.filter(({ status }) => ['unreachable', 'indeterminate'].includes(status));
const credentialRequired = results.filter(({ status }) => status === 'credential-required');
const ready = results.filter(({ status }) => status === 'ready');

function resultLine(result: CatalogHealthResult): string {
  return (
    `entry=${result.name} status=${result.status}` +
    ` expected_auth=${result.expectedAuth} observed_auth=${result.observedAuth}` +
    (result.reason ? ` reason=${result.reason}` : '') +
    (result.error ? ` error=${JSON.stringify(result.error)}` : '')
  );
}

function annotationValue(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

const actions = process.argv.includes('--github-annotations');
for (const result of results) {
  const line = resultLine(result);
  if (actionable.includes(result)) {
    console.error(`[mcp-catalog/audit] ${line}`);
    if (actions)
      console.error(`::error title=MCP catalog actionable drift::${annotationValue(line)}`);
  } else if (advisory.includes(result)) {
    console.warn(`[mcp-catalog/audit] ${line}`);
    if (actions) console.warn(`::warning title=MCP catalog advisory::${annotationValue(line)}`);
  } else {
    console.log(`[mcp-catalog/audit] ${line}`);
    if (actions && result.status === 'credential-required') {
      console.log(`::notice title=MCP catalog credential not verified::${annotationValue(line)}`);
    }
  }
}

function tableCell(value: string | undefined): string {
  return (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const noteworthy = results.filter(({ status }) => status !== 'ready');
const summary = [
  '## MCP catalog health audit',
  '',
  `Checked ${results.length} entries: ${ready.length} fully ready, ${credentialRequired.length} credential-required (public challenge only), ${advisory.length} advisory, ${actionable.length} actionable.`,
  '',
  '| Entry | Status | Expected | Observed | Reason | Error |',
  '| --- | --- | --- | --- | --- | --- |',
  ...noteworthy.map(
    (item) =>
      `| \`${item.name}\` | ${item.status} | ${item.expectedAuth} | ${item.observedAuth} | ${tableCell(item.reason)} | ${tableCell(item.error)} |`
  ),
  '',
  '> Reachability/indeterminate results are advisory. Authentication contradictions, unusable OAuth contracts, and a newly usable OAuth route for a bearer exception are actionable and fail this audit.',
].join('\n');

const summaryFlag = process.argv.indexOf('--summary-file');
const summaryFile = summaryFlag >= 0 ? process.argv[summaryFlag + 1] : undefined;
if (summaryFile) await appendFile(summaryFile, `${summary}\n`);

console.log(
  `[mcp-catalog/audit] complete total=${results.length} ready=${ready.length}` +
    ` credential_required=${credentialRequired.length} advisory=${advisory.length}` +
    ` actionable=${actionable.length}`
);
if (actionable.length > 0) process.exitCode = 1;
