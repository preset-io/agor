import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Deployment-owned config only, before the daemon starts and under the runtime
// volume lock. Add tools without replacing unrelated policy or user credentials.
export async function addRuntimeTools(path, selection, { load, dump, isInstallableAgenticTool }) {
  const selected = selection.split(',').map((value) => value.trim());
  if (!selected.length || selected.some((value) => !isInstallableAgenticTool(value))) {
    throw new Error('Invalid runtime tool selection');
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('Config must be a regular file');
  const original = await readFile(path, 'utf8');
  const config = load(original);
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Invalid config');
  const policy = config.agentic_tools ?? {};
  if (typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Invalid tool policy');
  const existing = policy.installed ?? [];
  if (!Array.isArray(existing) || existing.some((value) => !isInstallableAgenticTool(value))) {
    throw new Error('Invalid installed tool policy');
  }
  const installed = [...new Set([...existing, ...selected])];
  if (JSON.stringify(installed) === JSON.stringify(existing)) return false;
  config.agentic_tools = { ...policy, installed };
  const suffix = randomUUID();
  const temporary = `${path}.${suffix}.tmp`;
  // Private, exact backup before any mutation; never emit config contents.
  await writeFile(`${path}.before-tools-${suffix}`, original, { mode: 0o600, flag: 'wx' });
  try {
    await writeFile(temporary, dump(config), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const require = createRequire('/app/packages/core/package.json');
    const yaml = require('js-yaml');
    const { isInstallableAgenticTool } = await import(
      '/app/packages/core/dist/agentic-integrations.js'
    );
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: opt-in container startup policy, not a Turbo task.
    await addRuntimeTools('/home/agor/.agor/config.yaml', process.env.AGOR_RUNTIME_ADD_TOOLS, {
      ...yaml,
      isInstallableAgenticTool,
    });
    console.log('Runtime tool policy aligned.');
  } catch {
    console.error('Runtime tool configuration failed; config contents withheld.');
    process.exitCode = 1;
  }
}
