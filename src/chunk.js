import { createHash } from 'node:crypto';

export const TARGET_CHUNK_BYTES = 1600;
export const MAX_CHUNK_BYTES = 4000;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Line-oriented chunking. No model, no tokenizer, no network.
// Every chunk carries the exact byte and line span it came from, because the retrieval
// contract promises the customer an exact locator, not an approximate one.
export function chunkText(buffer) {
  const chunks = [];
  const total = buffer.length;
  if (total === 0) return chunks;

  // Byte offset at which each 1-indexed line starts.
  const lineStarts = [0];
  for (let i = 0; i < total; i += 1) {
    // A trailing newline terminates the last real line; it does not begin a phantom empty line.
    if (buffer[i] === 0x0a && i + 1 < total) lineStarts.push(i + 1);
  }
  const lineCount = lineStarts.length;

  let line = 0;
  let ordinal = 0;
  while (line < lineCount) {
    const startByte = lineStarts[line];
    let endLine = line;
    let endByte = line + 1 < lineCount ? lineStarts[line + 1] : total;
    while (endLine + 1 < lineCount) {
      const nextEnd = endLine + 2 < lineCount ? lineStarts[endLine + 2] : total;
      const candidateSize = nextEnd - startByte;
      if (candidateSize > MAX_CHUNK_BYTES) break;
      endLine += 1;
      endByte = nextEnd;
      if (endByte - startByte >= TARGET_CHUNK_BYTES) break;
    }
    // A single line longer than MAX_CHUNK_BYTES still becomes exactly one chunk; we never
    // split mid-line, because a locator that points into the middle of a line is not useful.
    const slice = buffer.subarray(startByte, endByte);
    const text = slice.toString('utf8');
    // Whitespace is still source content. Dropping a whitespace-only piece would make the stored
    // document non-contiguous while its full-document locator continued to cover the omitted
    // bytes, which is false provenance. FTS simply will not match this piece.
    chunks.push({
      ordinal: ordinal++,
      start_byte: startByte,
      end_byte: endByte,
      start_line: line + 1,
      end_line: endLine + 1,
      text,
      text_sha256: sha256(slice)
    });
    line = endLine + 1;
  }
  return chunks;
}
