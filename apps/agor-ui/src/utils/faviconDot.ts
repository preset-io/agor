/**
 * Create a favicon with status dot overlays
 *
 * @param baseFaviconUrl - Path to base favicon image
 * @param runningDot - If true, show white dot on lower-left (agent working)
 * @param readyDot - If true, show green dot on lower-right (ready for prompt)
 * @param greenColor - Hex color for the green dot (from theme)
 * @returns Promise resolving to data URL for the modified favicon
 */
export function createFaviconWithDot(
  baseFaviconUrl: string,
  runningDot: boolean,
  readyDot: boolean,
  greenColor: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;

    const img = new Image();
    img.onload = () => {
      // Draw base favicon
      ctx.drawImage(img, 0, 0, 32, 32);

      const dotSize = 10;

      // Draw white dot on lower-left if running
      if (runningDot) {
        const dotX = dotSize / 2 + 2; // Lower-left corner
        const dotY = 32 - dotSize / 2 - 2;

        // Dark border for contrast against light backgrounds
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotSize / 2 + 1, 0, 2 * Math.PI);
        ctx.fillStyle = '#000000';
        ctx.fill();

        // White dot
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotSize / 2, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }

      // Draw green dot on lower-right if ready
      if (readyDot) {
        const dotX = 32 - dotSize / 2 - 2; // Lower-right corner
        const dotY = 32 - dotSize / 2 - 2;

        // Dark border for contrast
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotSize / 2 + 1, 0, 2 * Math.PI);
        ctx.fillStyle = '#000000';
        ctx.fill();

        // Green dot (theme color)
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotSize / 2, 0, 2 * Math.PI);
        ctx.fillStyle = greenColor;
        ctx.fill();
      }

      resolve(canvas.toDataURL());
    };
    img.onerror = (err) => {
      reject(err);
    };
    img.src = baseFaviconUrl;
  });
}
