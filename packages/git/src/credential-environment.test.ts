import { describe, expect, it } from 'vitest';
import { buildGitProcessEnvironment, filterUserGitEnvironment } from './index';

describe('buildGitProcessEnvironment', () => {
  it('keeps required Git runtime metadata but drops deployment secrets and ambient capabilities', () => {
    expect(
      buildGitProcessEnvironment({
        PATH: '/usr/bin',
        HOME: '/home/daemon',
        HTTPS_PROXY: 'https://proxy.example',
        LC_ALL: 'C.UTF-8',
        AGOR_MASTER_SECRET: 'master-canary',
        DATABASE_URL: 'database-canary',
        JWT_SECRET: 'jwt-canary',
        OPENAI_API_KEY: 'provider-canary',
        SSH_AUTH_SOCK: '/tmp/daemon-agent.sock',
        GIT_PROXY_COMMAND: 'attacker-command',
        GIT_CONFIG_PARAMETERS: "'credential.helper=!attacker-command'",
      })
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/daemon',
      HTTPS_PROXY: 'https://proxy.example',
      LC_ALL: 'C.UTF-8',
    });
  });
});

describe('filterUserGitEnvironment', () => {
  it('retains credential, network, TLS, identity, and ordinary custom values', () => {
    const result = filterUserGitEnvironment({
      GITHUB_TOKEN: 'token-canary',
      HTTPS_PROXY: 'https://proxy.example',
      SSL_CERT_FILE: '/certs/corporate.pem',
      GIT_AUTHOR_EMAIL: 'user@example.com',
      CUSTOM_FORGE_TOKEN: 'custom-canary',
    });

    expect(result.rejected).toEqual([]);
    expect(result.env).toEqual({
      GITHUB_TOKEN: 'token-canary',
      HTTPS_PROXY: 'https://proxy.example',
      SSL_CERT_FILE: '/certs/corporate.pem',
      GIT_AUTHOR_EMAIL: 'user@example.com',
      CUSTOM_FORGE_TOKEN: 'custom-canary',
    });
  });

  it('rejects config, executable, helper, pager, trace, and repository-path controls', () => {
    const dangerous = {
      LD_PRELOAD: '/tmp/attacker.so',
      NODE_OPTIONS: '--require=/tmp/attacker.js',
      BASH_ENV: '/tmp/attacker.sh',
      PATH: '/tmp/attacker-bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.sshCommand',
      GIT_CONFIG_VALUE_0: 'attacker-command',
      GIT_CONFIG_PARAMETERS: "'credential.helper=!attacker-command'",
      GIT_SSH_COMMAND: 'attacker-command',
      GIT_ASKPASS: '/tmp/attacker-command',
      SSH_ASKPASS: '/tmp/attacker-command',
      GIT_EDITOR: 'attacker-command',
      GIT_PAGER: 'attacker-command',
      PAGER: 'attacker-command',
      GIT_EXTERNAL_DIFF: 'attacker-command',
      GIT_PROXY_COMMAND: 'attacker-command',
      GIT_TEMPLATE_DIR: '/tmp/attacker-template',
      GIT_EXEC_PATH: '/tmp/attacker-bin',
      GIT_DIR: '/unrelated/repository',
      GIT_WORK_TREE: '/unrelated/worktree',
      GIT_OBJECT_DIRECTORY: '/unrelated/objects',
      GIT_TRACE2_EVENT: '/tmp/exfiltration-log',
      'bad-key': 'malformed',
      NUL_VALUE: 'bad\0value',
    };

    const result = filterUserGitEnvironment(dangerous);

    expect(result.env).toEqual({});
    expect(new Set(result.rejected)).toEqual(new Set(Object.keys(dangerous)));
  });
});
