import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUploadBlob } from './uploadBlob';

describe('openUploadBlob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function open(type: string, download = false) {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:upload';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchors: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      anchors.push(this);
    });
    openUploadBlob(new Blob(['payload'], { type }), 'file.name', download);
    return { blob: blobs[0], anchor: anchors[0] };
  }

  it.each(['text/html', 'image/svg+xml', 'application/xml', 'text/javascript', ''])(
    'downloads %s as an opaque octet-stream instead of opening it in the Agor origin',
    (type) => {
      const { blob, anchor } = open(type);
      expect(blob.type).toBe('application/octet-stream');
      expect(anchor.download).toBe('file.name');
      expect(anchor.target).toBe('');
    }
  );

  it('opens inline-safe images and PDFs in a new tab', () => {
    for (const type of ['image/png', 'application/pdf']) {
      const { blob, anchor } = open(type);
      expect(blob.type).toBe(type);
      expect(anchor.download).toBe('');
      expect(anchor.target).toBe('_blank');
      vi.restoreAllMocks();
    }
  });

  it('honors an explicit download for inline-safe types', () => {
    const { anchor } = open('image/png', true);
    expect(anchor.download).toBe('file.name');
  });
});
