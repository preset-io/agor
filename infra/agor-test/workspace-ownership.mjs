// Trusted-host maintenance only, with workspace tools stopped.
import assert from 'node:assert/strict';
import { lchown, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const { validateTree } = await import(require.resolve('@agor/core/workspaces'));
export async function ownWorkspaceSource(workspace, tree) {
  validateTree(tree, []);
  // Only synchronized entries are touched. Keep private Git and potentially huge
  // dependency/cache trees intact, matching normal worker session preparation.
  for (const name of Object.keys(tree)) await lchown(path.join(workspace, name), 1000, 1000);
  await lchown(workspace, 1000, 1000);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [workspace] = process.argv.slice(2);
  assert(
    /^\/var\/lib\/agor\/tenants\/[A-Za-z0-9_-]+\/branches\/[a-f0-9-]{36}\/replicas\/[a-f0-9-]{36}\/workspace$/.test(
      workspace
    )
  );
  const tree = JSON.parse(
    await readFile(path.join(path.dirname(workspace), 'replica-tree.json'), 'utf8')
  );
  await ownWorkspaceSource(workspace, tree);
  console.log(JSON.stringify({ sourceOwnershipReady: true, paths: Object.keys(tree).length }));
}
