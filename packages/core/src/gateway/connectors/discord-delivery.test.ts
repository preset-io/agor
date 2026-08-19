import { describe, expect, it } from 'vitest';

import { parseGatewayProviderActionExecutionMetadata } from '../../db/repositories/gateway-provider-action-codec';
import {
  createDiscordDeliveryPlan,
  DISCORD_DELIVERY_FORMATTER_VERSION,
  DISCORD_DELIVERY_MAX_OVERFLOW_BYTES,
  discordDeliveryIdentityMatches,
} from './discord-delivery';

describe('Discord delivery formatter identity', () => {
  it('freezes deterministic per-chunk descriptors without persisted content', () => {
    const source = `${'a'.repeat(2_000)}\n\n${'b'.repeat(2_000)}\n\nend`;
    const first = createDiscordDeliveryPlan(source, '018f1e5d-0000-7000-8000-000000000001');
    const second = createDiscordDeliveryPlan(source, '018f1e5d-0000-7000-8000-000000000001');

    expect(first.metadata).toEqual(second.metadata);
    expect(first.metadata.formatter_version).toBe(DISCORD_DELIVERY_FORMATTER_VERSION);
    expect(first.metadata.chunks.length).toBeGreaterThan(1);
    expect(JSON.stringify(first.metadata)).not.toContain(source.slice(0, 100));
    expect(
      first.metadata.chunks.every((chunk) => /^[a-f0-9]{64}$/.test(chunk.descriptor_sha256))
    ).toBe(true);
    expect(first.chunks.map((chunk) => chunk.nonce)).toHaveLength(
      new Set(first.chunks.map((chunk) => chunk.nonce)).size
    );
  });

  it('describes the bounded overflow attachment on only the final chunk', () => {
    const source = Array.from({ length: 20 }, (_, index) => `${index}:${'x'.repeat(1_950)}`).join(
      '\n\n'
    );
    const plan = createDiscordDeliveryPlan(source, 'message-id');

    expect(plan.metadata.chunks).toHaveLength(8);
    expect(plan.metadata.overflow_attachment).toMatchObject({
      chunk_index: 7,
      filename: 'agor-response.md',
      byte_length: Buffer.byteLength(source, 'utf8'),
    });
    expect(plan.chunks.filter((chunk) => chunk.overflowAttachment)).toHaveLength(1);
    expect(plan.chunks.at(-1)?.overflowAttachment?.markdown).toBe(source);
    expect(JSON.stringify(plan.metadata)).not.toContain(source.slice(0, 100));
  });

  it('detects canonical-source and formatter descriptor changes', () => {
    const original = createDiscordDeliveryPlan('hello', 'message', 'canonical A');
    const sourceChanged = createDiscordDeliveryPlan('hello', 'message', 'canonical B');
    const renderedChanged = createDiscordDeliveryPlan('hello!', 'message', 'canonical A');

    expect(discordDeliveryIdentityMatches(original.metadata, sourceChanged.metadata)).toBe(false);
    expect(discordDeliveryIdentityMatches(original.metadata, renderedChanged.metadata)).toBe(false);
  });

  it('decodes bounded stored formatter versions and fails identity comparison across versions', () => {
    const current = createDiscordDeliveryPlan('hello', 'message').metadata;
    const storedFromAnotherRelease = {
      ...current,
      formatter_version: DISCORD_DELIVERY_FORMATTER_VERSION + 1,
    };

    expect(
      parseGatewayProviderActionExecutionMetadata(storedFromAnotherRelease, 'deliver_message')
    ).toEqual(storedFromAnotherRelease);
    expect(discordDeliveryIdentityMatches(storedFromAnotherRelease, current)).toBe(false);
    expect(() =>
      parseGatewayProviderActionExecutionMetadata(
        { ...current, formatter_version: 0 },
        'deliver_message'
      )
    ).toThrow(/execution metadata/);
  });

  it('strictly rejects non-Snowflake, duplicate, unbounded, and unknown checkpoint data', () => {
    const metadata = createDiscordDeliveryPlan('hello', 'message').metadata;
    expect(parseGatewayProviderActionExecutionMetadata(metadata, 'deliver_message')).toEqual(
      metadata
    );
    expect(() =>
      parseGatewayProviderActionExecutionMetadata(
        {
          ...metadata,
          chunks: [{ ...metadata.chunks[0], provider_message_id: 'not-a-snowflake' }],
        },
        'deliver_message'
      )
    ).toThrow(/chunk checkpoint/);
    expect(() =>
      parseGatewayProviderActionExecutionMetadata(
        { ...metadata, unexpected: true },
        'deliver_message'
      )
    ).toThrow(/execution metadata/);
    expect(() =>
      parseGatewayProviderActionExecutionMetadata(
        { ...metadata, source_sha256: 'f'.repeat(4_097) },
        'deliver_message'
      )
    ).toThrow(/execution metadata/);
    expect(() =>
      parseGatewayProviderActionExecutionMetadata(
        {
          ...metadata,
          overflow_attachment: {
            chunk_index: 0,
            filename: 'agor-response.md',
            content_sha256: 'f'.repeat(64),
            byte_length: DISCORD_DELIVERY_MAX_OVERFLOW_BYTES + 1,
          },
        },
        'deliver_message'
      )
    ).toThrow(/overflow checkpoint/);
  });
});
