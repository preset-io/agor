/**
 * Create a favicon with a colored status dot overlay
 *
 * @param baseFaviconUrl - Path to base favicon image
 * @param dotColor - Color of status dot ('green', 'orange', or null for no dot)
 * @returns Promise resolving to data URL for the modified favicon
 */
export function createFaviconWithDot(
  baseFaviconUrl: string,
  dotColor: 'green' | 'orange' | null
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

      // Draw status dot if specified
      if (dotColor) {
        const dotSize = 10;
        const dotX = 32 - dotSize / 2 - 2; // Bottom-right corner
        const dotY = 32 - dotSize / 2 - 2;

        // Outer white border for contrast
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotSize / 2 + 1, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        // Colored dot
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotSize / 2, 0, 2 * Math.PI);

        switch (dotColor) {
          case 'green':
            ctx.fillStyle = '#52c41a'; // Ant Design success green
            break;
          case 'orange':
            ctx.fillStyle = '#faad14'; // Ant Design warning orange
            break;
        }
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
