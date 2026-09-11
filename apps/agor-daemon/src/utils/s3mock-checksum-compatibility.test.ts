import { Readable } from 'node:stream';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { enableS3MockChecksumCompatibility } from './s3mock-checksum-compatibility.js';

describe('S3Mock header compatibility (real SDK, stubbed HTTP)', () => {
  it.each([false, true])(
    'preserves SDK-computed checksum with compatibility=%s',
    async (enabled) => {
      const requests: Record<string, string>[] = [];
      const client = new S3Client({
        region: 'us-east-1',
        credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
        requestHandler: {
          handle: async (request) => {
            requests.push({ ...request.headers });
            return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
          },
        },
      });
      if (enabled) enableS3MockChecksumCompatibility(client);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: 'fixture',
            Key: 'fixture',
            Body: Buffer.from('hello'),
            ChecksumAlgorithm: 'SHA256',
          })
        );
        expect(requests[0]['x-amz-checksum-sha256']).toBe(
          'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ='
        );
        expect(requests[0]['x-amz-sdk-checksum-algorithm']).toBe(enabled ? undefined : 'SHA256');
        // Signing must happen after header normalization.
        expect(requests[0].authorization).toContain('x-amz-checksum-sha256');
        if (enabled)
          expect(requests[0].authorization).not.toContain('x-amz-sdk-checksum-algorithm');
      } finally {
        client.destroy();
      }
    }
  );
});
