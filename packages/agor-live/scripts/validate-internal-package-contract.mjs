import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUNDLED_INTERNAL_PACKAGES } from './package-contract.js';

const [packageRootArgument] = process.argv.slice(2);
if (!packageRootArgument)
  throw new Error('Usage: validate-internal-package-contract.mjs <internal-package-root>');

const packageRoot = resolve(packageRootArgument);
for (const bundledPackage of BUNDLED_INTERNAL_PACKAGES) {
  await access(resolve(packageRoot, bundledPackage.distDirectory, 'package.json'));
}

console.log(
  `  ✓ Bundled package contract: ${BUNDLED_INTERNAL_PACKAGES.map(({ name }) => `@agor/${name}`).join(', ')}`
);
