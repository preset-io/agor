/**
 * Bounded response-body reading for the catalog's outbound requests.
 *
 * Both callers fetch from hosts nobody vetted — the public registry, and
 * whatever endpoints registry records name — so neither may let a remote decide
 * how much memory to allocate.
 */

/**
 * Read a response body, giving up once it exceeds `maxBytes`.
 *
 * Returns null when the limit is crossed.
 *
 * `response.text()` cannot express this: it buffers the entire body before
 * anything can measure it, so a length check made afterwards is defeated by an
 * absent or dishonest `Content-Length`. Counting bytes off the stream bounds
 * the allocation itself, and counts real UTF-8 bytes rather than
 * `string.length`, which undercounts multibyte text.
 */
export async function readCappedBody(response: Response, maxBytes: number): Promise<string | null> {
  const body = response.body;
  if (!body) return '';

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) return null;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}
