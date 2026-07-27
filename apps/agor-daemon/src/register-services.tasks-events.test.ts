import { feathers } from '@agor/core/feathers';
import { describe, expect, it } from 'vitest';
import { TASKS_SERVICE_CUSTOM_EVENTS } from './services/tasks-events.js';

describe('Tasks service transport events', () => {
  it('registers termination_requested at the Feathers transport boundary', () => {
    const app = feathers();
    app.use(
      'tasks',
      {
        async get() {
          return {};
        },
      },
      {
        methods: ['get'],
        events: [...TASKS_SERVICE_CUSTOM_EVENTS],
      }
    );

    const service = app.service('tasks') as unknown as Record<PropertyKey, unknown>;
    const options = Object.getOwnPropertySymbols(service)
      .map((symbol) => service[symbol])
      .find(
        (value): value is { events: string[]; serviceEvents: string[] } =>
          !!value && typeof value === 'object' && 'events' in value && 'serviceEvents' in value
      );
    if (!options) throw new Error('Feathers service registration options were not installed');
    expect(options.events).toContain('termination_requested');
    expect(options.serviceEvents).toContain('termination_requested');
  });
});
