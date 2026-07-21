import type { UrlImageContentBlock } from '@agor-live/client';

const ATTACHMENT_HEADER = 'Attached files:';

export function hidePreviewedImageAttachments(
  text: string,
  images: UrlImageContentBlock[]
): string {
  const previewedFilenames = new Set(
    images.flatMap((image) => (image.filename ? [image.filename] : []))
  );
  if (previewedFilenames.size === 0) return text;

  let blockStart = 0;
  let blockEnd = text.indexOf('\n\n');
  if (!text.startsWith(`${ATTACHMENT_HEADER}\n`)) {
    const suffixStart = text.lastIndexOf(`\n\n${ATTACHMENT_HEADER}\n`);
    if (suffixStart < 0) return text;
    blockStart = suffixStart + 2;
    blockEnd = text.length;
  } else if (blockEnd < 0) {
    blockEnd = text.length;
  }

  const blockLines = text.slice(blockStart, blockEnd).split('\n');
  const attachmentLines = blockLines.slice(1);
  if (
    blockLines[0] !== ATTACHMENT_HEADER ||
    attachmentLines.length === 0 ||
    attachmentLines.some((line) => !line.startsWith('- ') || line.length === 2)
  ) {
    return text;
  }

  const attachmentFilenames = attachmentLines.map((line) => line.slice(2).split(/[\\/]/).pop());
  const remainingLines = attachmentLines.filter((_line, index) => {
    const filename = attachmentFilenames[index];
    return (
      !filename ||
      !previewedFilenames.has(filename) ||
      attachmentFilenames.indexOf(filename) !== attachmentFilenames.lastIndexOf(filename)
    );
  });
  if (remainingLines.length === attachmentLines.length) return text;

  if (remainingLines.length > 0) {
    const visibleBlock = [ATTACHMENT_HEADER, ...remainingLines].join('\n');
    return `${text.slice(0, blockStart)}${visibleBlock}${text.slice(blockEnd)}`;
  }
  if (blockStart === 0) return blockEnd === text.length ? '' : text.slice(blockEnd + 2);
  return text.slice(0, blockStart - 2);
}
