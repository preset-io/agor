// Run inside the Agor container; uses its packaged YAML parser and private home.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const yaml = require('js-yaml');
const selected = process.argv.slice(2);
if (!selected.length || selected.some((tool) => !['claude-code', 'codex'].includes(tool))) {
  throw new Error('Select claude-code and/or codex');
}
const file = '/home/agor/.agor/config.yaml';
const config = yaml.load(await readFile(file, 'utf8'));
config.agentic_tools = { ...config.agentic_tools, installed: [...new Set(selected)] };
const temporary = `${file}.tools-${process.pid}`;
await writeFile(temporary, yaml.dump(config), { flag: 'wx', mode: 0o600 });
await rename(temporary, file);
console.log(`Configured agent tools: ${selected.join(', ')}`);
