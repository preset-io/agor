// Run inside the new image against the existing data bind, before startup.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const yaml = require('js-yaml');
const filename = '/home/agor/.agor/config.yaml';
const config = yaml.load(await readFile(filename, 'utf8'));
config.agentic_tools = { ...config.agentic_tools, installed: ['claude-code'] };
config.execution = {
  ...config.execution,
  unix_user_mode: 'simple',
  branch_storage: {
    ...config.execution?.branch_storage,
    default_mode: 'clone',
    allowed_modes: ['clone'],
  },
  executor_command_template:
    'node /opt/agor-runtime/lib/node_modules/agor-live/dist/executor/workspaces/dispatch-cli.js /run/agor/dispatcher.json {tenant_id}',
  executor_response: {
    ...config.execution?.executor_response,
    external_protocol: 'executor-response-v1',
    origin_url: 'https://agor.skellige.com.au',
  },
  branch_workspace: {
    enabled: true,
    native_adapter: 'claude_workspace',
    backend: 'local_replicated',
    clone: 'reflink',
  },
};
await writeFile(filename, yaml.dump(config), { mode: 0o600 });
console.log('Enabled Claude replicated workspace dispatch and HTTPS response transport.');
