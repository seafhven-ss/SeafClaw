/**
 * Telegram's hard limit is 4096 UTF-16 code units.
 * We keep our base limit at 3970 so that after formatChunks adds the
 * "[Part NN/NN]\n" header (up to ~15 chars), the final message always
 * stays safely below the limit.
 */
const MAX_MESSAGE_LENGTH = 3970;

/**
 * Split a long text into chunks suitable for Telegram messages.
 * Each raw chunk is guaranteed to be ≤ MAX_MESSAGE_LENGTH characters.
 */
export function chunkText(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Prefer to split at a newline so we don't cut mid-line
    let splitIndex = remaining.lastIndexOf('\n', maxLength);

    // Fall back to a space if no newline found in the window
    if (splitIndex < 1) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }

    // Force split at maxLength if no natural boundary found
    if (splitIndex < 1) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  // Guard: drop any accidentally empty chunks (e.g. from all-whitespace tail)
  return chunks.filter((c) => c.length > 0);
}

/**
 * Add part indicators to multi-chunk messages.
 * The header size is accounted for: each output message fits within
 * Telegram's 4096-character limit because MAX_MESSAGE_LENGTH is already
 * reduced to leave room for the header.
 */
export function formatChunks(chunks: string[]): string[] {
  if (chunks.length === 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => {
    const header = `[Part ${index + 1}/${chunks.length}]\n`;
    return header + chunk;
  });
}
