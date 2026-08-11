import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { describe, expect, it } from 'vitest';

describe('AWS SDK S3 streaming boundary', () => {
  it('passes a Node stream through managed Upload without buffering in adapter JSON', async () => {
    let requestBody = '';
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      requestHandler: {
        async handle(request: { body?: unknown }) {
          for await (const chunk of request.body as NodeJS.ReadableStream) {
            requestBody += Buffer.from(typeof chunk === 'number' ? [chunk] : chunk).toString();
          }
          return {
            response: {
              statusCode: 200,
              headers: { etag: '"test-etag"' },
              body: Readable.from(''),
            },
          };
        },
      },
    });
    const upload = new Upload({
      client,
      params: {
        Bucket: 'test-bucket',
        Key: 'tenant/upload',
        Body: Readable.from('streamed-body'),
      },
      leavePartsOnError: false,
    });
    await expect(upload.done()).resolves.toBeDefined();
    expect(requestBody).toContain('streamed-body');
    client.destroy();
  });
});
