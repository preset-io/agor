/**
 * TemplatesService tests.
 *
 * Renders happen in `@agor/core/templates/handlebars-helpers` (already
 * heavily tested); this suite covers the service-layer surface — input
 * validation, error shape, and authorization contract.
 */

import { BadRequest } from '@agor/core/feathers';
import type { AuthenticatedParams } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { TemplatesService } from './templates';

const internalParams = {} as AuthenticatedParams; // no provider → internal call, skips role check

describe('TemplatesService.create', () => {
  it('renders a basic template with context', async () => {
    const svc = new TemplatesService();
    const result = await svc.create(
      { template: 'hello {{name}}', context: { name: 'world' } },
      internalParams
    );
    expect(result.rendered).toBe('hello world');
  });

  it('throws BadRequest when template is missing', async () => {
    const svc = new TemplatesService();
    await expect(
      svc.create({ template: undefined as unknown as string }, internalParams)
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it('throws BadRequest when template is not a string', async () => {
    const svc = new TemplatesService();
    await expect(
      svc.create({ template: 42 as unknown as string }, internalParams)
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it("returns '' on render failure when onError is 'empty' (default)", async () => {
    const svc = new TemplatesService();
    // Unknown helper triggers a Handlebars compile/runtime error, which the
    // shared renderTemplate swallows according to onError.
    const result = await svc.create(
      { template: '{{nope-unknown-helper x}}', context: {} },
      internalParams
    );
    expect(result.rendered).toBe('');
  });

  it("returns the raw template when onError is 'raw'", async () => {
    const svc = new TemplatesService();
    const template = '{{nope-unknown-helper x}}';
    const result = await svc.create({ template, context: {}, onError: 'raw' }, internalParams);
    expect(result.rendered).toBe(template);
  });
});
