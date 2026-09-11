import type { S3Client } from '@aws-sdk/client-s3';

/**
 * S3Mock 5.2.0 treats the SDK algorithm hint as evidence of a trailer and
 * ignores an explicit checksum header. lib-storage uses buffered parts with
 * header checksums. Remove only the redundant hint, AFTER SDK hashing and
 * BEFORE signing. Never remove a checksum, alter a trailer request, or relax
 * receipt verification. This is opt-in for the development emulator only.
 */
export function enableS3MockChecksumCompatibility(client: S3Client): void {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (
        context.commandName === 'PutObjectCommand' ||
        context.commandName === 'UploadPartCommand'
      ) {
        const request = args.request as { headers: Record<string, string> };
        const algorithm = request.headers['x-amz-sdk-checksum-algorithm'];
        if (
          ['SHA256', 'SHA1', 'CRC32', 'CRC32C', 'CRC64NVME'].includes(algorithm) &&
          request.headers[`x-amz-checksum-${algorithm.toLowerCase()}`] &&
          !request.headers['x-amz-trailer']
        ) {
          delete request.headers['x-amz-sdk-checksum-algorithm'];
        }
      }
      return next(args);
    },
    { step: 'build', priority: 'low', name: 's3MockChecksumCompatibility' }
  );
}
