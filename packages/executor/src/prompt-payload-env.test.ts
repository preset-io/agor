import { afterEach, describe, expect, it } from 'vitest';
import { applyPromptPayloadEnvironment } from './prompt-payload-env';

const POD_OWNED_ENVIRONMENT = {
  HOME: '/synthetic/pod/home',
  PATH: '/synthetic/pod/bin',
  USER: 'synthetic-pod-user',
  LOGNAME: 'synthetic-pod-logname',
  SHELL: '/synthetic/pod/shell',
  NODE_OPTIONS: '--synthetic-pod-node-policy',
  BASH_ENV: '/synthetic/pod/bash-env',
  ENV: '/synthetic/pod/shell-env',
  AGOR_MASTER_SECRET: 'synthetic-pod-master-secret',
  LD_PRELOAD: '/synthetic/pod/lib/policy.so',
  LD_AUDIT: '/synthetic/pod/lib/audit.so',
  LD_PROFILE: 'synthetic-pod-profile-policy',
  LD_DEBUG: 'synthetic-pod-loader-policy',
  DYLD_INSERT_LIBRARIES: '/synthetic/pod/lib/dyld-policy.dylib',
  DYLD_LIBRARY_PATH: '/synthetic/pod/lib',
} as const;

const ORDINARY_ENV_NAME = 'SYNTHETIC_PAYLOAD_SETTING';
const touchedNames = [...Object.keys(POD_OWNED_ENVIRONMENT), ORDINARY_ENV_NAME] as const;
const originalEnvironment = Object.fromEntries(touchedNames.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of touchedNames) {
    const original = originalEnvironment[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe('prompt payload process environment boundary', () => {
  it('retains pod-owned HOME and loader policy while applying ordinary payload env', () => {
    Object.assign(process.env, POD_OWNED_ENVIRONMENT);

    const result = applyPromptPayloadEnvironment({
      HOME: '/synthetic/daemon/home',
      PATH: '/synthetic/payload/bin',
      USER: 'synthetic-payload-user',
      LOGNAME: 'synthetic-payload-logname',
      SHELL: '/synthetic/payload/shell',
      NODE_OPTIONS: '--require=/synthetic/payload/inject.cjs',
      BASH_ENV: '/synthetic/payload/bash-env',
      ENV: '/synthetic/payload/shell-env',
      AGOR_MASTER_SECRET: 'synthetic-payload-master-secret',
      LD_PRELOAD: '/synthetic/payload/lib/inject.so',
      LD_AUDIT: '/synthetic/payload/lib/audit.so',
      LD_PROFILE: 'synthetic-payload-profile-control',
      LD_DEBUG: 'synthetic-payload-loader-control',
      DYLD_INSERT_LIBRARIES: '/synthetic/payload/lib/inject.dylib',
      DYLD_LIBRARY_PATH: '/synthetic/payload/lib',
      [ORDINARY_ENV_NAME]: 'ordinary-payload-value',
    });

    expect(
      Object.fromEntries(Object.keys(POD_OWNED_ENVIRONMENT).map((key) => [key, process.env[key]]))
    ).toEqual(POD_OWNED_ENVIRONMENT);
    expect(process.env[ORDINARY_ENV_NAME]).toBe('ordinary-payload-value');
    expect(result).toEqual({
      applied: [ORDINARY_ENV_NAME],
      rejected: [],
      identityDenied: Object.keys(POD_OWNED_ENVIRONMENT),
    });
  });
});
