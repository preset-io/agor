/**
 * Tests for .agor.yml parser
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoEnvironmentConfig } from '../types/worktree';
import { type AgorYmlSchema, parseAgorYml, writeAgorYml } from './agor-yml';

describe('parseAgorYml', () => {
  it('should parse valid .agor.yml with all fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-yml-test-'));
    const agorYmlPath = path.join(tmpDir, '.agor.yml');

    const yamlContent = `environment:
  start: "docker compose up -d"
  stop: "docker compose down"
  health: "http://localhost:{{add 9000 worktree.unique_id}}/health"
  app: "http://localhost:{{add 5000 worktree.unique_id}}"
  logs: "docker compose logs --tail=100"`;

    fs.writeFileSync(agorYmlPath, yamlContent);

    const config = parseAgorYml(agorYmlPath);

    expect(config).toEqual({
      up_command: 'docker compose up -d',
      down_command: 'docker compose down',
      health_check: {
        type: 'http',
        url_template: 'http://localhost:{{add 9000 worktree.unique_id}}/health',
      },
      app_url_template: 'http://localhost:{{add 5000 worktree.unique_id}}',
      logs_command: 'docker compose logs --tail=100',
    });

    // Cleanup
    fs.unlinkSync(agorYmlPath);
    fs.rmdirSync(tmpDir);
  });

  it('should parse valid .agor.yml with only required fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-yml-test-'));
    const agorYmlPath = path.join(tmpDir, '.agor.yml');

    const yamlContent = `environment:
  start: "pnpm dev"
  stop: "pkill -f 'pnpm dev'"`;

    fs.writeFileSync(agorYmlPath, yamlContent);

    const config = parseAgorYml(agorYmlPath);

    expect(config).toEqual({
      up_command: 'pnpm dev',
      down_command: "pkill -f 'pnpm dev'",
    });

    // Cleanup
    fs.unlinkSync(agorYmlPath);
    fs.rmdirSync(tmpDir);
  });

  it('should return null if file does not exist', () => {
    const config = parseAgorYml('/nonexistent/path/.agor.yml');
    expect(config).toBeNull();
  });

  it('should throw error if YAML syntax is invalid', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-yml-test-'));
    const agorYmlPath = path.join(tmpDir, '.agor.yml');

    fs.writeFileSync(agorYmlPath, 'invalid: yaml: syntax:');

    expect(() => parseAgorYml(agorYmlPath)).toThrow('Invalid YAML syntax');

    // Cleanup
    fs.unlinkSync(agorYmlPath);
    fs.rmdirSync(tmpDir);
  });

  it('should throw error if start command is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-yml-test-'));
    const agorYmlPath = path.join(tmpDir, '.agor.yml');

    const yamlContent = `environment:
  stop: "docker compose down"`;

    fs.writeFileSync(agorYmlPath, yamlContent);

    expect(() => parseAgorYml(agorYmlPath)).toThrow('must have "start" and "stop" commands');

    // Cleanup
    fs.unlinkSync(agorYmlPath);
    fs.rmdirSync(tmpDir);
  });

  it('should return null if no environment section', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-yml-test-'));
    const agorYmlPath = path.join(tmpDir, '.agor.yml');

    const yamlContent = `other:
  field: "value"`;

    fs.writeFileSync(agorYmlPath, yamlContent);

    const config = parseAgorYml(agorYmlPath);
    expect(config).toBeNull();

    // Cleanup
    fs.unlinkSync(agorYmlPath);
    fs.rmdirSync(tmpDir);
  });
});

describe('writeAgorYml', () => {
  it('should write valid .agor.yml with all fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-yml-test-'));
    const agorYmlPath = path.join(tmpDir, '.agor.yml');

    const config: RepoEnvironmentConfig = {
      up_command: 'docker compose up -d',
      down_command: 'docker compose down',
      health_check: {
        type: 'http',
        url_template: 'http://localhost:9000/health',
      },
      app_url_template: 'http://localhost:5000',
      logs_command: 'docker compose logs --tail=100',
    };

    writeAgorYml(agorYmlPath, config);

    expect(fs.existsSync(agorYmlPath)).toBe(true);

    // Read back and verify
    const parsed = parseAgorYml(agorYmlPath);
    expect(parsed).toEqual(config);

    // Cleanup
    fs.unlinkSync(agorYmlPath);
    fs.rmdirSync(tmpDir);
  });

  it('should write valid .agor.yml with only required fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-yml-test-'));
    const agorYmlPath = path.join(tmpDir, '.agor.yml');

    const config: RepoEnvironmentConfig = {
      up_command: 'pnpm dev',
      down_command: 'pkill -f "pnpm dev"',
    };

    writeAgorYml(agorYmlPath, config);

    expect(fs.existsSync(agorYmlPath)).toBe(true);

    // Read back and verify
    const parsed = parseAgorYml(agorYmlPath);
    expect(parsed).toEqual(config);

    // Cleanup
    fs.unlinkSync(agorYmlPath);
    fs.rmdirSync(tmpDir);
  });

  it('should round-trip config correctly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-yml-test-'));
    const agorYmlPath = path.join(tmpDir, '.agor.yml');

    const originalConfig: RepoEnvironmentConfig = {
      up_command: 'PORT={{add 5000 worktree.unique_id}} pnpm dev',
      down_command: 'pkill -f "vite.*{{add 5000 worktree.unique_id}}"',
      health_check: {
        type: 'http',
        url_template: 'http://localhost:{{add 5000 worktree.unique_id}}/health',
      },
      app_url_template: 'http://localhost:{{add 5000 worktree.unique_id}}',
    };

    // Write
    writeAgorYml(agorYmlPath, originalConfig);

    // Read back
    const parsedConfig = parseAgorYml(agorYmlPath);

    // Should match exactly
    expect(parsedConfig).toEqual(originalConfig);

    // Cleanup
    fs.unlinkSync(agorYmlPath);
    fs.rmdirSync(tmpDir);
  });
});
