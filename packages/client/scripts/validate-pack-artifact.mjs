#!/usr/bin/env node

import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agor-client-pack-'));

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function commandErrorMessage(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const commandError = error;
  const diagnostics = [commandError.stdout, commandError.stderr]
    .map((output) => (output ? String(output).trim() : ''))
    .filter(Boolean);
  return [error.message, ...diagnostics].join('\n');
}

function listFilesRecursive(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

let tarballName;

try {
  const packOutput = execSync('npm pack --json', { cwd: packageDir, encoding: 'utf8' });
  const parsed = JSON.parse(packOutput);
  tarballName = parsed?.[0]?.filename;
  if (!tarballName) {
    throw new Error('npm pack did not return a filename');
  }
  execSync(`tar -xzf ${JSON.stringify(tarballName)} -C ${JSON.stringify(tempDir)}`, {
    cwd: packageDir,
  });
} catch (error) {
  fail(
    `Unable to create/extract npm pack artifact: ${error instanceof Error ? error.message : String(error)}`
  );
}

const packedRoot = path.join(tempDir, 'package');
const packedManifestPath = path.join(packedRoot, 'package.json');
const packedManifest = JSON.parse(readFileSync(packedManifestPath, 'utf8'));
const consumerRoot = path.join(tempDir, 'consumer');

const dependencySections = [
  ['dependencies', packedManifest.dependencies ?? {}],
  ['peerDependencies', packedManifest.peerDependencies ?? {}],
  ['optionalDependencies', packedManifest.optionalDependencies ?? {}],
];

const privateWorkspacePackagePattern = /^@agor\//;

for (const [sectionName, deps] of dependencySections) {
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      fail(`Packed manifest contains workspace protocol in ${sectionName}: ${name}=${version}`);
    }
    if (privateWorkspacePackagePattern.test(name)) {
      fail(`Packed manifest contains private workspace package in ${sectionName}: ${name}`);
    }
  }
}

function findPrivateWorkspaceModuleReference(content) {
  const moduleInfo = ts.preProcessFile(content, true, true);
  const references = [
    ...moduleInfo.importedFiles,
    ...moduleInfo.typeReferenceDirectives,
    ...moduleInfo.libReferenceDirectives,
    ...moduleInfo.referencedFiles,
  ];
  return references
    .map((reference) => reference.fileName)
    .find((specifier) => privateWorkspacePackagePattern.test(specifier));
}

const packedFiles = listFilesRecursive(packedRoot);
const runtimeFiles = packedFiles.filter((file) => file.endsWith('.js') || file.endsWith('.cjs'));
const typeFiles = packedFiles.filter(
  (file) => file.endsWith('.d.ts') || file.endsWith('.d.cts') || file.endsWith('.d.mts')
);

for (const file of runtimeFiles) {
  const content = readFileSync(file, 'utf8');
  const privateReference = findPrivateWorkspaceModuleReference(content);
  if (privateReference) {
    fail(
      `Runtime artifact still references private workspace package ${privateReference}: ${path.relative(packedRoot, file)}`
    );
  }
}

for (const file of typeFiles) {
  const content = readFileSync(file, 'utf8');
  const privateReference = findPrivateWorkspaceModuleReference(content);
  if (privateReference) {
    fail(
      `Type artifact still references private workspace package ${privateReference}: ${path.relative(packedRoot, file)}`
    );
  }
}

const privateReferenceProbe = "type Leaked = import('@agor/git').GitRepo;";
if (findPrivateWorkspaceModuleReference(privateReferenceProbe) !== '@agor/git') {
  fail('Private workspace reference detector does not recognize declaration import() types');
}

const packedNodeModules = path.join(packedRoot, 'node_modules');
mkdirSync(packedNodeModules, { recursive: true });
const linkedDependencies = new Set();
for (const [sectionName, deps] of dependencySections) {
  for (const name of Object.keys(deps)) {
    if (linkedDependencies.has(name)) {
      continue;
    }
    const source = path.join(packageDir, 'node_modules', ...name.split('/'));
    if (!existsSync(source)) {
      if (sectionName !== 'optionalDependencies') {
        fail(`Installed package is missing packed ${sectionName} dependency: ${name}`);
      }
      continue;
    }
    const destination = path.join(packedNodeModules, ...name.split('/'));
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(source, destination, 'junction');
    linkedDependencies.add(name);
  }
}

const requiredRuntimeExports = [
  'TOOL_API_KEY_NAMES',
  'AGENTIC_TOOL_DISPLAY_NAMES',
  'AGENTIC_TOOL_KEY_CREATION_URL',
  'AGENTIC_TOOL_CAPABILITIES',
  'shortId',
  'isValidSlug',
  'REPO_SLUG_PATTERN',
];
try {
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `const {createRequire}=await import('node:module'); const require=createRequire(import.meta.url); const clients=[require(${JSON.stringify(path.join(packedRoot, 'dist/index.cjs'))}), await import(${JSON.stringify(path.join(packedRoot, 'dist/index.js'))})]; for (const client of clients) for (const name of ${JSON.stringify(requiredRuntimeExports)}) { if (!(name in client)) throw new Error('Missing runtime export: ' + name); }`,
  ]);
} catch (error) {
  fail(
    `Packed client entrypoint failed or is missing public runtime exports: ${commandErrorMessage(error)}`
  );
}

try {
  const consumerPackageDir = path.join(consumerRoot, 'node_modules', '@agor-live', 'client');
  mkdirSync(path.dirname(consumerPackageDir), { recursive: true });
  symlinkSync(packedRoot, consumerPackageDir, 'junction');
  writeFileSync(
    path.join(consumerRoot, 'consumer.ts'),
    `import { createClient, createRestClient } from '@agor-live/client';
import type * as Client from '@agor-live/client';

const socketClient: Client.AgorClient = createClient('http://localhost:3030', false);
const reactiveClient: Client.ReactiveAgorClient = createClient('http://localhost:3030', false);
const restClient: Promise<Client.AuthenticatedAgorClient> = createRestClient();

async function useAuthentication(client: Client.AuthenticatedAgorClient) {
  await client.authenticate();
  await client.reAuthenticate();
  await client.logout();
}

type PublicClientTypes = [
  Client.AgorService<Client.Session>,
  Client.BoardsService,
  Client.BranchesService,
  Client.ClientInput<Client.Session>,
  Client.FindResult<Client.Task>,
  Client.GatewayChannelsService,
  Client.MessagesService,
  Client.PaginatedResult<Client.Session>,
  Client.ReposCloneService,
  Client.ReposLocalService,
  Client.ReposService,
  Client.SchedulesService,
  Client.ServiceTypes,
  Client.SessionPromptOptions,
  Client.SessionsService,
  Client.TaskRunOptions,
  Client.TaskRunRequest,
  Client.TasksClientHelpers,
  Client.TasksService,
  Client.TemplateRenderRequest,
  Client.TemplateRenderResponse,
  Client.TemplatesService,
];

void socketClient;
void reactiveClient;
void restClient;
void useAuthentication;
void (undefined as unknown as PublicClientTypes);
`
  );
  writeFileSync(
    path.join(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: 'ES2022',
        },
        include: ['consumer.ts'],
      },
      null,
      2
    )}\n`
  );
  execFileSync(
    process.execPath,
    [path.join(packageDir, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc')],
    {
      cwd: consumerRoot,
      stdio: 'pipe',
    }
  );
} catch (error) {
  fail(`Packed client declarations are missing public client types: ${commandErrorMessage(error)}`);
}

try {
  if (tarballName) {
    unlinkSync(path.join(packageDir, tarballName));
  }
  rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Best-effort cleanup only.
}

if (!process.exitCode) {
  console.log('✅ npm pack artifact is standalone and its public client types are consumable');
}
