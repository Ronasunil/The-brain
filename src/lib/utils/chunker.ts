import { createHash } from "crypto";

export interface ChunkResult {
  content: string;       // "File: path\n\n<chunk text>"
  chunkIndex: number;
  filePath: string;
  sourceChunkId: string; // deterministic hash for dedup
}

/**
 * Chunk a file's raw content into overlapping segments.
 * Each chunk is prefixed with "File: <filePath>\n\n" for citation context.
 */
export function chunkFileContent(
  filePath: string,
  rawContent: string,
  maxChars: number = 3000,
  overlap: number = 200,
): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  const prefix = `File: ${filePath}\n\n`;
  const effectiveMax = maxChars - prefix.length;

  if (effectiveMax <= 0) {
    // File path is too long to leave room for content — skip
    return chunks;
  }

  if (rawContent.length <= effectiveMax) {
    const content = prefix + rawContent;
    chunks.push({
      content,
      chunkIndex: 0,
      filePath,
      sourceChunkId: computeChunkId(filePath, 0, content),
    });
    return chunks;
  }

  let start = 0;
  let index = 0;
  while (start < rawContent.length) {
    const end = Math.min(start + effectiveMax, rawContent.length);
    const content = prefix + rawContent.slice(start, end);
    chunks.push({
      content,
      chunkIndex: index,
      filePath,
      sourceChunkId: computeChunkId(filePath, index, content),
    });

    const nextStart = start + effectiveMax - overlap;
    if (nextStart <= start) break; // safety: avoid infinite loop
    start = nextStart;
    index++;
  }

  return chunks;
}

/**
 * Compute a deterministic chunk ID for dedup.
 * sha256(filePath::chunkIndex::content) truncated to 32 hex chars.
 */
function computeChunkId(
  filePath: string,
  chunkIndex: number,
  content: string,
): string {
  return createHash("sha256")
    .update(`${filePath}::${chunkIndex}::${content}`)
    .digest("hex")
    .slice(0, 32);
}
