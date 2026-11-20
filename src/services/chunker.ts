/**
 * Text chunking for embedding.
 *
 * Turbopuffer recommends ~300-token chunks with a two-sentence overlap, split on
 * natural boundaries. Chat transcripts already have the best boundary available —
 * the message — so callers chunk one message at a time and never merge across
 * them; this module only subdivides a single message that is too long.
 */

/** Turbopuffer's own rule of thumb: ~4 bytes of English text per token. */
const CHARS_PER_TOKEN = 4;
export const CHUNK_TARGET_TOKENS = 300;
export const CHUNK_OVERLAP_SENTENCES = 2;

/** Split on sentence ends and blank lines, both of which read as real breaks. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function chunkText(
  text: string,
  targetTokens: number,
  overlapSentences: number,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const targetChars = targetTokens * CHARS_PER_TOKEN;
  if (trimmed.length <= targetChars) return [trimmed];

  const sentences = splitSentences(trimmed);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const chunk = current.join(" ").trim();
    if (chunk.length > 0) chunks.push(chunk);
  };

  for (const sentence of sentences) {
    // Code blocks and pasted logs arrive as one enormous "sentence"; hard-split
    // them rather than emitting a chunk the model cannot attend to.
    if (sentence.length > targetChars) {
      flush();
      current = [];
      currentLength = 0;
      for (let offset = 0; offset < sentence.length; offset += targetChars) {
        chunks.push(sentence.slice(offset, offset + targetChars));
      }
      continue;
    }

    if (currentLength + sentence.length > targetChars && current.length > 0) {
      flush();
      const overlap =
        overlapSentences > 0 ? current.slice(-overlapSentences) : [];
      current = [...overlap];
      currentLength = overlap.reduce(
        (total, part) => total + part.length + 1,
        0,
      );
    }

    current.push(sentence);
    currentLength += sentence.length + 1;
  }

  flush();
  return chunks;
}
