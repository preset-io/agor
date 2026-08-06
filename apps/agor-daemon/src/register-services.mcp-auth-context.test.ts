import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const servicesSource = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');
const routesSource = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');
const sessionsSource = readFileSync(new URL('./services/sessions.ts', import.meta.url), 'utf8');

describe('task MCP runtime context wiring', () => {
  it('carries the authoritative task creator through every common executor launch', () => {
    expect(sessionsSource).toMatch(/prompterUserId:\s*UserID/);
    expect(routesSource).toContain('prompterUserId: task.created_by');
    expect(servicesSource).toContain('const prompterUserId = data.prompterUserId');
    expect(servicesSource).toContain('prompterUserId,');
    expect(servicesSource).toContain('generateToken(\n      sessionId,\n      prompterUserId,');
    expect(servicesSource).toContain('createUserProcessEnvironment(\n        prompterUserId,');
    expect(servicesSource).toContain('const sessionUnixUser = prompterUser.unix_username');
  });

  it('uses the task creator for OAuth availability without crossing tenant scope', () => {
    expect(servicesSource).toContain('getMcpServerAvailabilityForSession');
    expect(servicesSource).toContain("app.service('mcp-servers/oauth-auth-headers').create");
    expect(servicesSource).toContain('user: prompterUser');
    expect(servicesSource).toContain('runWithTenantDatabaseScope(db, tenantId');
  });

  it('adds dynamic auth state only to the provider-facing prompt', () => {
    expect(routesSource).toContain('content: task.full_prompt');
    expect(servicesSource).toContain('renderMcpAuthMissingContext');
    expect(servicesSource).toContain('prompt: promptForProvider');
    expect(servicesSource).not.toContain('renderAgorSystemPrompt');
  });
});
