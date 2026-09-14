import type { AgorClient, Repo } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import {
  destinationProblem,
  validateDestinationUrl,
  waitForDestinationReady,
} from './teammateDestination';

const home = {
  repo_id: 'owned',
  remote_url: 'https://github.com/me/memory.git',
  clone_status: 'ready',
} as Repo;
describe('explicit teammate destination', () => {
  it('never treats the public starter, a name or missing remote as a writable home', () => {
    for (const remote_url of [
      'https://github.com/preset-io/agor-teammate.git',
      'git@github.com:preset-io/agor-teammate.git',
    ]) {
      expect(destinationProblem({ ...home, slug: 'agor-teammate-private', remote_url })).toMatch(
        /source, not your destination/
      );
    }
    expect(destinationProblem({ ...home, remote_url: undefined })).toMatch(/no remote/);
    expect(destinationProblem(undefined)).toMatch(/Choose/);
  });
  it.each([
    'https://secret@github.com/me/repo',
    'https://github.com/me/repo?token=secret',
    'file:///tmp/repo',
    'ext::command',
  ])('rejects unsafe URL %s before registration', (url) => {
    expect(() => validateDestinationUrl(url)).toThrow(/without a token/);
  });
  it('waits only for the requested ID and never falls back to a ready public repository', async () => {
    const get = vi.fn().mockResolvedValue({ ...home, clone_status: 'cloning' });
    const client = { service: () => ({ get }) } as unknown as AgorClient;
    await expect(waitForDestinationReady(client, 'owned', () => true, 0)).rejects.toThrow(
      /still cloning/
    );
    expect(get).toHaveBeenCalledExactlyOnceWith('owned');
    get.mockResolvedValue({ ...home, repo_id: 'public' });
    await expect(waitForDestinationReady(client, 'owned', () => true)).rejects.toThrow(
      /unexpected ID/
    );
  });
  it('propagates authorization failures and fences delayed results on caller replacement', async () => {
    const get = vi.fn().mockRejectedValue(new Error('Forbidden'));
    const client = { service: () => ({ get }) } as unknown as AgorClient;
    await expect(waitForDestinationReady(client, 'foreign-tenant-id', () => true)).rejects.toThrow(
      'Forbidden'
    );
    let current = true;
    get.mockImplementation(async () => {
      current = false;
      return home;
    });
    await expect(waitForDestinationReady(client, 'owned', () => current)).rejects.toThrow(
      /cancelled/
    );
  });
});
